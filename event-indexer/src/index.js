const assert = require('assert');
const _colors = require('colors');
const { Conflux, format } = require('js-conflux-sdk');
const fs = require('fs');
const jayson = require('jayson/promise');
const cors = require('cors');
const morgan = require('morgan');
const connect = require('connect');
const jsonParser = require('body-parser').json;
const namehash = require('eth-ens-namehash').hash;
const Web3EthAbi = require('web3-eth-abi');

const Events = require('./events');
const Database = require('./database');
const Network = require('./network');

const ENS_ADDRESS = '0x87E87fA4b4402DfD641fd67dF7248C673Db31db1';
const START_EPOCH = 20000000;

const NODE_URL = 'ws://test.confluxrpc.org/ws/v2';
const conflux = new Conflux({ url: NODE_URL, networkId: 1 });
conflux.provider.setMaxListeners(0); // suppress warning

const network = new Network(conflux);

function printStats(prev, interval, lastTen) {
    const current = network.numRequests;
    const addition = current - prev;

    lastTen.shift();
    lastTen.push(addition);
    assert(lastTen.length == 60);

    const sum = lastTen.reduce((a, b) => a + b, 0);
    const avg = sum / 60;

    console.log(`sent = ${current} (+${addition}), average (/s) = ${avg}`);
    setTimeout(() => printStats(current, interval, lastTen), interval);
}

printStats(0, 1000, new Array(60).fill(0));

const ABIS = {
    ENS: JSON.parse(fs.readFileSync('abis/ENS.abi')),
    PUBLIC_RESOLVER: JSON.parse(fs.readFileSync('abis/PublicResolver.abi')),
    REPO: JSON.parse(fs.readFileSync('abis/Repo.abi')),
    TOKEN_MANAGER: JSON.parse(fs.readFileSync('abis/TokenManager.abi')),
};

const KNOWN_APP_IDS = {
    '0x7e852e0fcfce6551c13800f1e7476f982525c2b5277ba14b24339c68416336d1': 'VAULT',
    '0xbf8491150dafc5dcaee5b861414dca922de09ccffa344964ae167212e8c673ae': 'FINANCE',
    '0x9fa3927f639745e587912d4b0fea7ef9013bf93fb907d29faeab57417ba6e1d4': 'VOTING',
    '0x6b20a3010614eeebf2138ccec99f028a61c811b3b1a3343b6ff635985c75c91f': 'TOKENS',
    '0xe3262375f45a6e2026b7e7b18c2b807434f2508fe1a2a3dfb493c7df8f4aad6a': 'ACL',
    '0x3b4bf6bf3ad5000ecf0f989d5befde585c6860fea3e574a4fab4c49d1c177d9c': 'KERNEL',
    '0xddbcfd564f642ab5627cf68b9b7d374fb4f8a36e941a75d89c87998cef03bd61': 'EVM_SCRIPT_REGISTRY',
    '0x9ac98dc5f995bf0211ed589ef022719d1487e5cb2bab505676f0d084c07cf89a': 'AGENT',

    // TODO: this relies on ENS registrar root node
    '0x7b4f7602faf178a4a239b8b2ed4155358e256b08ee7c6b6b1b01ebec891ce1f1': 'APM-REPO',
};

const RUNNING = new Set();

function prepareEvent(event) {
    const [_name, ...params] = event.slice(0, -1).split(/[(,]/);
    const sig = Web3EthAbi.encodeEventSignature(event);
    const decode = data => Web3EthAbi.decodeParameters(params, data);
    return { sig, decode };
}

const EVENTS = {
    NewRepo: prepareEvent('NewRepo(bytes32,string,address)'),
    DeployDao: prepareEvent('DeployDao(address)'),
    NewFactoryCloneToken: prepareEvent('NewFactoryCloneToken(address,address,uint)'),
    DeployDAO: prepareEvent('DeployDAO(address)'),
    DeployToken: prepareEvent('DeployToken(address)'),
    NewAppProxy: prepareEvent('NewAppProxy(address,bool,bytes32)'),
    NewVersion: prepareEvent('NewVersion(uint256,uint16[3])'),
    SetPermission: prepareEvent('SetPermission(address,address,bytes32,bool)'),
    SetPermissionParams: prepareEvent('SetPermissionParams(address,address,bytes32,bytes32)'),
    ChangePermissionManager: prepareEvent('ChangePermissionManager(address,bytes32,address)'),
}

// lookup address of AragonPM under 'aragonpm.eth'
async function lookupAragonPM(ens) {
    const ENS = await conflux.Contract({ abi: ABIS.ENS, address: ens });
    const node = format.hexBuffer(namehash('aragonpm.eth'));
    let address = await ENS.resolver(node);
    const PublicResolver = await conflux.Contract({ abi: ABIS.PUBLIC_RESOLVER, address });
    const apm = await PublicResolver.addr(node);
    return format.hexAddress(apm);
}

// implement special handling for some log types
async function handleLog(db, ctx, log) {
    // new Repo
    if (log.topics[0] === EVENTS.NewRepo.sig) {
        const { '0': id, '1': name, '2': repo } = EVENTS.NewRepo.decode(log.data);
        console.log(`[${ctx.name}] new Repo at epoch ${log.epochNumber}: ${id}, ${name}, ${repo}`.bold.yellow);
        track(db, `${name}@repo`, repo, log.epochNumber);
    }

    // deploy new DAO
    if (log.topics[0] === EVENTS.DeployDao.sig) {
        const { '0': address } = EVENTS.DeployDao.decode(log.data);
        console.log(`[${ctx.name}] new DAO at epoch ${log.epochNumber} (kernel: ${address})`.bold.yellow);
        track(db, `DAO@${address.substring(0, 10)} (Kernel)`, address, log.epochNumber);
    }

    // deploy new token
    if (log.topics[0] === EVENTS.DeployToken.sig) {
        const { '0': address } = EVENTS.DeployToken.decode(log.data);
        console.log(`[${ctx.name}] new token at epoch ${log.epochNumber} (address: ${address})`.bold.yellow);
        track(db, `DAO@${address.substring(0, 10)} (Token)`, address, log.epochNumber);
    }

    // install new app
    else if (log.topics[0] === EVENTS.NewAppProxy.sig) {
        let { '0': address, '1': _isUpgradable, '2': appId } = EVENTS.NewAppProxy.decode(log.data);
        if (KNOWN_APP_IDS[appId] !== undefined) { appId = KNOWN_APP_IDS[appId]; }
        console.log(`[${ctx.name}] NewAppProxy(${address}, ${appId})`.bold.yellow);

        // we have special handling for Repos through the `NewRepo` event
        if (appId === 'APM-REPO') {
            return;
        }

        const dao = format.hexAddress(log.address);
        track(db, `DAO@${dao.substring(0, 10)} (${appId})`, address, log.epochNumber);
    }

    else if (log.topics[0] === EVENTS.NewVersion.sig) {
        let { '0': versionId, '1': semanticVersion } = EVENTS.NewVersion.decode(log.data);

        let { contractAddress, contentURI } = await conflux.Contract({ abi: ABIS.REPO, address: ctx.address }).getBySemanticVersion(semanticVersion);
        contractAddress = format.hexAddress(contractAddress);
        contentURI = contentURI.toString();

        console.log(`[${ctx.name}] NewVersion(${versionId}, ${semanticVersion.join('.')}): ${contractAddress}, ${contentURI}`.bold.yellow);

        const baseName = ctx.name.replace(/@repo$/, '');
        track(db, `${baseName}@${semanticVersion.join('.')}`, contractAddress, log.epochNumber);
    }

    else if (log.topics[0] === EVENTS.SetPermission.sig) {
        console.log(`[${ctx.name}] SetPermission`.bold.yellow);
    }

    else if (log.topics[0] === EVENTS.SetPermissionParams.sig) {
        console.log(`[${ctx.name}] SetPermissionParams`.bold.yellow);
    }

    else if (log.topics[0] === EVENTS.ChangePermissionManager.sig) {
        console.log(`[${ctx.name}] ChangePermissionManager`.bold.yellow);
    }
}

// track contract `name` at address `address` from epoch `from`.
// if the contract is already present in DB, we will continue from the stored epoch.
async function track(db, name, address, from, untilEpoch = Number.MAX_SAFE_INTEGER) {
    if (RUNNING.has(name)) {
        return;
    }

    from = await db.initContract(name, address, from) + 1;
    console.log(`[${name}] starting from ${from}...`);
    RUNNING.add(name);

    const events = new Events(network, name, address, [], from);

    while (true) {
        try {
            for await (const [epoch, logs] of events.get()) {
                if (logs.length > 0) {
                    console.log(`[${name}] found ${logs.length} logs in epoch ${epoch}`.bold.green);
                }

                // execute special logic for logs
                for (const log of logs) {
                    await handleLog(db, { address, name }, log);
                }

                // store epoch logs in db
                // even with no logs, we periodically commit progress
                if (logs.length > 0 || epoch % 10000 == 0 || epoch === untilEpoch) {
                    db.storeEpochLogs(epoch, address, logs);
                }

                if (epoch === untilEpoch) {
                    console.error(`[${name}] reached epoch ${untilEpoch}, finishing`.bold.white);
                    return;
                }
            }
        }
        catch (err) {
            console.error(`[${name}] unexpected error:`.bold.red, err);
            process.exit();
        }
    }
}

function startServer(db, port) {
    const app = connect();

    const server = jayson.server({
        cfx_getLogs: async function(args) {
            return await db.getLogs(args[0]);
        }
    });

    morgan.token('body', (req, res) => JSON.stringify(req.body));
    app.use(morgan(':method :url :status :response-time ms - :res[content-length] :body - :req[content-length]'));
    app.use(cors({methods: ['POST']}));
    app.use(jsonParser());
    app.use(server.middleware());

    app.listen(port);
}

async function main() {
    // init db
    const db = new Database();

    await db.init({
        'host': '127.0.0.1',
        'port': 3306,
        'user': 'user',
        'password': 'password',
        'database': 'db',
    });

    // make sure to close db on exit
    process.stdin.resume();
    process.on('exit', async () => { db.close(); process.exit(); });
    process.on('SIGINT', async () => { db.close(); process.exit(); });
    process.on('SIGUSR1', async () => { db.close(); process.exit(); });
    process.on('SIGUSR2', async () => { db.close(); process.exit(); });
    process.on('uncaughtException', async (r) => { console.error(r); db.close(); process.exit(); });

    // init contracts in DB
    const [entries] = await db.pool.query('SELECT * from latest');

    // find and track AragonPM if necessary
    if (!entries.some(_ => _.name === 'apm')) {
        const apm = await lookupAragonPM(ENS_ADDRESS);
        track(db, 'apm', apm, START_EPOCH);
    }

    // start tracking contracts
    for (const entry of entries) {
        track(db, entry.name, entry.address, entry.latest + 1);
    }

    // start RPC server
    startServer(db, 3000);
}

main();