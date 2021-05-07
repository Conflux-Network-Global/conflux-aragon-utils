const assert = require('assert');
const colors = require('colors');

const MAX_EPOCH_GAP = 1000;

const snooze = ms => new Promise(resolve => setTimeout(resolve, ms));

class Events {
    constructor(conflux, name, address, topics, startEpoch) {
        this.conflux = conflux;
        this.name = name;
        this.address = address;
        this.topics = topics;
        this.nextToQuery = startEpoch;
        this.nextToReturn = startEpoch;
        this.buffer = {};
    }

    async *get() {
        while (true) {
            // try to return from local buffer
            while (this.nextToReturn < this.nextToQuery) {
                const epoch = this.nextToReturn;
                this.nextToReturn += 1;

                if (typeof this.buffer[epoch] !== 'undefined') {
                    const logs = this.buffer[epoch];

                    assert(logs.length > 0);
                    assert(epoch == logs[0].epochNumber);

                    delete this.buffer[epoch];
                    yield [epoch, logs];
                }
                else {
                    yield [epoch, []];
                }
            }

            // request more
            const best = await this.conflux.getEpochNumber('latest_confirmed');
            const fromEpoch = this.nextToQuery;
            const toEpoch = Math.min(fromEpoch + MAX_EPOCH_GAP - 1, best);

            if (toEpoch < fromEpoch) {
                // console.log('caught up, sleeping...'.grey);
                await snooze(10000);
                continue;
            }

            // console.log(`[${this.name}] filtering ${fromEpoch}..${toEpoch}...`.grey);

            const logs = await this.conflux.getLogs({
                address: this.address,
                topics: this.topics,
                fromEpoch,
                toEpoch,
            });

            this.buffer = {};

            for (const log of logs) {
                this.buffer[log.epochNumber] = this.buffer[log.epochNumber] || [];
                this.buffer[log.epochNumber].push(log);
            }

            this.nextToQuery = toEpoch + 1;
        }
    }
}

module.exports = Events;