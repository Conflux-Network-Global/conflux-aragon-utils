const { Command } = require('commander');
const fs = require('fs');
const { Conflux } = require('js-conflux-sdk');
const Web3EthAbi = require('web3-eth-abi');

require('dotenv').config()

const NEW_REPO = Web3EthAbi.encodeEventSignature('NewRepo(bytes32,string,address)');
const NODE_URL = 'http://test.confluxrpc.org';

const Repo = JSON.parse(fs.readFileSync('Repo.abi'));
const APMRegistry = JSON.parse(fs.readFileSync('APMRegistry.abi'));

const conflux = new Conflux({ url: NODE_URL });

async function list(apm) {
    const fromEpoch = Number(await conflux.Contract({ abi: APMRegistry, address: apm }).getInitializationEpoch());
    const toEpoch = Math.min(fromEpoch + 9999, await conflux.getEpochNumber('latest_state'))
    console.log(`querying NewRepo logs between ${fromEpoch}..${toEpoch}...`);

    const repos = await conflux.getLogs({
        address: apm,
        fromEpoch,
        toEpoch,
        topics: [[NEW_REPO]],
    });

    for (const raw of repos) {
        const { '1': repoName, '2': address } = Web3EthAbi.decodeParameters(['bytes32', 'string', 'address'], raw.data);
        const latest = await conflux.Contract({ abi: Repo, address }).getLatest();
        console.log(`${repoName.padStart(20)} is at ${address} (latest version: ${latest.semanticVersion.join('.')} at ${latest.contractAddress}, contentURI: ${latest.contentURI.toString('utf8')})`);
    }
}

async function register(repo, newVersion, newAddress, newContentURI) {
    newVersion = newVersion.split('.');

    const account = conflux.wallet.addPrivateKey(process.env.PRIVATE_KEY);
    const contract = await conflux.Contract({ abi: Repo, address: repo });

    const old = await contract.getLatest();
    console.log(`current version: ${old.semanticVersion.join('.')} at ${old.contractAddress}, contentURI: ${old.contentURI.toString('utf8')}`);

    try {
        console.log('updating...')

        await contract
            .newVersion(newVersion, newAddress, newContentURI)
            .sendTransaction({ from: account })
            .executed();
    } catch (err) {
        console.error(`update failed: ${err}`);
        return;
    }

    const updated = await contract.getLatest();
    console.log(`new version: ${updated.semanticVersion.join('.')} at ${updated.contractAddress}, contentURI: ${updated.contentURI.toString('utf8')}`);
}

async function main() {
    const program = new Command();

    program
        .command('list <apm>')
        .description('clone a repository into a newly created directory')
        .action(list);

    program
        .command('register <repo> <newVersion> <newAddress> <newContentURI>')
        .description('clone a repository into a newly created directory')
        .action(register);

    program.parse();
}

main();