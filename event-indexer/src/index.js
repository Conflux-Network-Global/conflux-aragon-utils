const _colors = require('colors');
const { Conflux, format } = require('js-conflux-sdk');
const fs = require('fs');
const jayson = require('jayson/promise');
const namehash = require('eth-ens-namehash').hash;
const Web3EthAbi = require('web3-eth-abi');

const Events = require('./events');
const Database = require('./database');

const ENS_ADDRESS = '0x884cd1b7907d9f46e890feebba926cb071f03c2c';
const START_EPOCH = 17929248;

const NODE_URL = 'ws://test.confluxrpc.org/ws/v2';
const conflux = new Conflux({ url: NODE_URL, networkId: 1 });
conflux.provider.setMaxListeners(0); // suppress warning

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
};

const TO_WATCH = [
    'apm-registry@repo',
    'apm-registry@1.0.1',
    'apm-enssub@repo',
    'apm-enssub@1.0.0',
    'apm-repo@repo',
    'apm-repo@1.0.0',
    'agent@repo',
    'agent@1.0.1',
    'vault@repo',
    'vault@1.0.1',
    'voting@repo',
    'voting@1.0.1',
    'survey@repo',
    'survey@1.0.1',
    'payroll@repo',
    'payroll@1.0.0',
    'finance@repo',
    'finance@1.0.1',
    'token-manager@repo',
    'token-manager@1.0.1',
    'bare-template@repo',
    'bare-template@1.0.1',
    'company-template@repo',
    'company-template@1.0.1',
    'membership-template@repo',
    'membership-template@1.0.1',
    'reputation-template@repo',
    'reputation-template@1.0.1',
];

const RUNNING = new Set();

function prepareEvent(event) {
    const [name, ...params] = event.slice(0, -1).split(/[(,]/);
    const sig = Web3EthAbi.encodeEventSignature(event);
    const decode = data => Web3EthAbi.decodeParameters(params, data);
    return { sig, decode };
}

const EVENTS = {
    NEW_REPO: prepareEvent('NewRepo(bytes32,string,address)'),
    DEPLOY_DAO: prepareEvent('DeployDao(address)'),
    DEPLOY_TOKEN: prepareEvent('DeployToken(address)'),
    NEW_APP_PROXY: prepareEvent('NewAppProxy(address,bool,bytes32)'),
    NEW_VERSION: prepareEvent('NewVersion(uint256,uint16[3])'),
    SET_PERMISSION: prepareEvent('SetPermission(address,address,bytes32,bool)'),
    SET_PERMISSION_PARAMS: prepareEvent('SetPermissionParams(address,address,bytes32,bytes32)'),
    CHANGE_PERMISSION_MANAGER: prepareEvent('ChangePermissionManager(address,bytes32,address)'),
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

// find repo `name` in `apm` starting from epoch `from`
async function findRepo(apm, name, from) {
    const events = new Events(conflux, 'main', apm, [EVENTS.NEW_REPO.sig], from);

    try {
        for await (const [_, logs] of events.get()) {
            for (const log of logs) {
                const { '1': repoName, '2': address } = EVENTS.NEW_REPO.decode(log.data);

                if (repoName === name) {
                    return address;
                }
            }
        }
    }
    catch (err) {
        console.error('[main] unexpected error:'.bold.red, err);
        throw err;
    }
}

// find contract `name` in `apm` starting from epoch `from`
async function findContract(name, apm, from) {
    const [template, version] = name.split('@');
    const repo = await findRepo(apm, template, from);

    if (version === 'repo') {
        console.log(`[main] ${template}@${version} is at ${repo}`.bold.green);
        return repo;
    }

    const latest = await conflux.Contract({ abi: ABIS.REPO, address: repo }).getBySemanticVersion(version.split('.'));
    const address = format.hexAddress(latest.contractAddress);
    console.log(`[main] ${template}@${version} is at ${address}`.bold.green);

    return address;
}

// implement special handling for some log types
async function handleLog(db, context, log) {
    // deploy new DAO
    // TODO: try tracking through DAOFactory directly
    if (log.topics[0] === EVENTS.DEPLOY_DAO.sig) {
        const { '0': address } = EVENTS.DEPLOY_DAO.decode(log.data);
        console.log(`[${context}] new DAO at epoch ${log.epochNumber} (kernel: ${address})`.bold.yellow);
        track(db, `DAO@${address.substring(0, 10)} (Kernel)`, address, log.epochNumber);
    }

    // deploy new token
    if (log.topics[0] === EVENTS.DEPLOY_TOKEN.sig) {
        const { '0': address } = EVENTS.DEPLOY_TOKEN.decode(log.data);
        console.log(`[${context}] new token at epoch ${log.epochNumber} (address: ${address})`.bold.yellow);
        track(db, `DAO@${address.substring(0, 10)} (Token)`, address, log.epochNumber);
    }

    // install new app
    else if (log.topics[0] === EVENTS.NEW_APP_PROXY.sig) {
        let { '0': address, '1': _isUpgradable, '2': appId } = EVENTS.NEW_APP_PROXY.decode(log.data);
        if (KNOWN_APP_IDS[appId] !== undefined) { appId = KNOWN_APP_IDS[appId]; }
        console.log(`[${context}] NewAppProxy(${address}, ${appId})`.bold.yellow);

        const dao = format.hexAddress(log.address);
        track(db, `DAO@${dao.substring(0, 10)} (${appId})`, address, log.epochNumber);
    }

    else if (log.topics[0] === EVENTS.NEW_VERSION.sig) {
        let { '0': versionId, '1': semanticVersion } = EVENTS.NEW_VERSION.decode(log.data);
        console.log(`[${context}] NewVersion(${versionId}, ${semanticVersion.join('.')})`.bold.yellow);
    }

    else if (log.topics[0] === EVENTS.SET_PERMISSION.sig) {
        console.log(`[${context}] SetPermission`.bold.yellow);
    }

    else if (log.topics[0] === EVENTS.SET_PERMISSION_PARAMS.sig) {
        console.log(`[${context}] SetPermissionParams`.bold.yellow);
    }

    else if (log.topics[0] === EVENTS.CHANGE_PERMISSION_MANAGER.sig) {
        console.log(`[${context}] ChangePermissionManager`.bold.yellow);
    }
}

// track contract `name` at address `address` from epoch `from`.
// if the contract is already present in DB, we will continue from the stored epoch.
async function track(db, name, address, from) {
    if (RUNNING.has(name)) {
        return;
    }

    from = await db.initContract(name, address, from) + 1;
    console.log(`[${name}] starting from ${from}...`);
    RUNNING.add(name);

    const events = new Events(conflux, name, address, [], from);

    while (true) {
        try {
            for await (const [epoch, logs] of events.get()) {
                if (logs.length > 0) {
                    console.log(`[${name}] found ${logs.length} logs in epoch ${epoch}`.bold.green);
                }

                // execute special logic for logs
                for (const log of logs) {
                    await handleLog(db, name, log);
                }

                // store epoch logs in db
                // even with no logs, we periodically commit progress
                if (logs.length > 0 || epoch % 10000 == 0) {
                    db.storeEpochLogs(epoch, address, logs);
                }
            }
        }
        catch (err) {
            console.error(`[${name}] unexpected error:`.bold.red, err);
        }
    }
}

function startServer(db, port) {
    const server = jayson.server({
        cfx_getLogs: async function(args) {
            return await db.getLogs(args[0]);
        }
    });

    server.http().listen(port);
}

async function main() {
    // init db
    const db = new Database();

    await db.init({
        'host': '127.0.0.1',
        'port': 3307,
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

    // find AragonPM
    const apm = await lookupAragonPM(ENS_ADDRESS);

    // init contracts in DB
    const [entries] = await db.pool.query('SELECT * from latest');
    const names = entries.map(_ => _.name);

    for (const name of TO_WATCH) {
        if (!names.includes(name)) {
            const address = await findContract(name, apm, START_EPOCH);
            await db.initContract(name, address, START_EPOCH);
            entries.unshift({ name, address, latest: START_EPOCH });
        }
    }

    // start tracking contracts
    for (const entry of entries) {
        track(db, entry.name, entry.address, entry.latest + 1);
    }

    // start RPC server
    startServer(db, 3000);
}

main();