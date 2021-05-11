const _ = require('underscore');
const { format } = require('js-conflux-sdk');
const _colors = require('colors');

class Network {
    constructor(conflux, batchSize = 200, requestPeriodMs = 1000) {
        this.conflux = conflux;
        this.batchSize = batchSize;
        this.requestPeriodMs = requestPeriodMs;

        // unique ID for each getLogs query received
        this.id = 0;

        // number of actual requests sent to Conflux node
        this.numRequests = 0;

        // id => { args, resolve }
        this.requests = {};

        // periodically make batched get logs requests
        setInterval(this.requestLogs.bind(this), this.requestPeriodMs);

        // epoch numbers
        this.latestCheckpoint = 0;
        this.latestConfirmed = 0;
        this.latestState = 0;
        this.latestMined = 0;

        // periodically make epoch requests
        setInterval(async () => {
            try {
                await this.requestEpochs();
            } catch (err) {
                console.error(`Error during cfx_getStatus: ${err}`.bold.red);
            }
        }, this.requestPeriodMs);
    }

    async requestEpochs() {
        const status = await this.conflux.getStatus();
        this.numRequests += 1;

        this.latestCheckpoint = status.latestCheckpoint;
        this.latestConfirmed = status.latestConfirmed;
        this.latestState = status.latestState;
        this.latestMined = status.epochNumber;
    }

    getLogs(args) {
        const id = this.id;
        this.id += 1;

        return new Promise((resolve, reject) => {
            this.requests[id] = { args, resolve };

            // timeout after 10s
            setTimeout(() => {
                if (id in this.requests) {
                    console.error(`Timeout for query ${id} with arguments ${JSON.stringify(args)}`);
                    reject();
                }
            }, 10000);
        });
    }

    async getEpochNumber(args) {
        switch (args) {
            case 'latest_checkpoint': return this.latestCheckpoint;
            case 'latest_confirmed': return this.latestConfirmed;
            case 'latest_state': return this.latestState;
            case 'latest_mined': return this.latestMined;
            default: throw `Unsupported getEpochNumber argument: ${args}`;
        }
    }

    requestLogs() {
        // group requests based on `fromEpoch`, `toEpoch`, and `topics`
        const requestGroups = _.groupBy(this.requests, (req) => [req.args.fromEpoch, req.args.toEpoch, req.args.topics]);
        this.requests = {}

        for (const group of Object.values(requestGroups)) {
            // these are the same for all items in `group`
            const fromEpoch = group[0].args.fromEpoch;
            const toEpoch = group[0].args.toEpoch;
            const topics = group[0].args.topics;

            // process groups in batches if there are too many
            for (const subgroup of _.chunk(group, this.batchSize)) {
                // collect addresses
                const addresses = subgroup.map(i => i.args.address);

                // address => resolve
                const resolve = {};

                for (const item of subgroup) {
                    resolve[item.args.address.toLowerCase()] = item.resolve;
                }

                // perform request
                console.log(`sending request: epochs ${fromEpoch}..${toEpoch} with topics '${topics}' (${addresses.length} addresses)`);

                const p = this.conflux.getLogs({
                    address: addresses,
                    topics,
                    fromEpoch,
                    toEpoch,
                });

                this.numRequests += 1;

                p.then((response) => {
                    // group response items by address
                    const responseGroups = _.groupBy(response, (resp) => resp.address);

                    // yield each group to the corresponding client
                    for (const group of Object.values(responseGroups)) {
                        const address = format.hexAddress(group[0].address).toLowerCase();
                        resolve[address](group);
                        delete resolve[address];
                    }

                    // resolve all the remaining (no logs)
                    for (const address of Object.keys(resolve)) {
                        resolve[address]([]);
                        delete resolve[address];
                    }
                })
            }
        }
    }
}

module.exports = Network;