const assert = require('assert');
const mysql = require('mysql2/promise');
const { format } = require('js-conflux-sdk');

class Database {
    async init(options) {
        // this.pool = await mysql.createPool(options);
        this.pool = await mysql.createConnection(options); // TODO
    }

    async initContract(name, address, creationEpoch) {
        const [rows, _fields] = await this.pool.execute(`SELECT * FROM latest WHERE address='${address}'`);

        if (rows.length > 0) {
            assert(rows.length == 1);
            assert(rows[0].name === name);
            return rows[0].latest;
        }

        // insert if not present
        await this.pool.execute(`INSERT INTO latest VALUES ('${name}', '${address}', ${creationEpoch}, ${creationEpoch - 1})`);
        return creationEpoch - 1;
    }

    async storeEpochLogs(epoch, address, logs) {
        await this.pool.beginTransaction();

        for (const log of logs) {
            assert(log.epochNumber == epoch);
            await this.pool.execute(`INSERT INTO events VALUES (${epoch}, '${log.blockHash}', '${log.address}', '${log.topics[0]}', '${log.topics[1]}', '${log.topics[2]}', '${log.topics[3]}', '${JSON.stringify(log)}')`);
        }

        await this.pool.execute(`UPDATE latest SET latest = ${epoch} WHERE address = '${address}'`);
        await this.pool.commit();
    }

    async getLogs(args) {
        const topicToQuery = (field, topic) => {
            if (!topic) return 'true';
            if (Array.isArray(topic)) return `${field} IN ('${topic.join(`', '`)}')`;
            if (typeof topic === 'string') return `${field} = '${topic}'`;
            throw `Unexpected topic: ${topic}`;
        }

        if (args.address !== 'undefined') {
            args.address = format.address(format.hexAddress(args.address), 1, true);
        }

        const q1 = `(epoch BETWEEN ${Number(args.fromEpoch)} AND ${Number(args.toEpoch)})`;
        const q2 = args.address ? `(address = '${args.address}')` : 'true';
        const q3 = args.topics ? `((${topicToQuery('topic0', args.topics[0])}) AND (${topicToQuery('topic1', args.topics[1])}) AND (${topicToQuery('topic2', args.topics[2])}) AND (${topicToQuery('topic3', args.topics[3])}))` : 'true';
        const q = `SELECT raw from events WHERE ${q1} AND ${q2} AND ${q3}`;
        console.log(q);

        const [rows, _fields] = await this.pool.execute(q);
        return rows.map(r => JSON.parse(r.raw));
    }

    async close() {
        await this.pool.end();
    }
}

module.exports = Database;