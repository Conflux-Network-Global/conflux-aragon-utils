const assert = require('assert');
const mysql = require('mysql2/promise');
const { format } = require('js-conflux-sdk');
const _colors = require('colors');

class Database {
    async init(options) {
        this.pool = await mysql.createPool(options);
    }

    async initContract(name, address, creationEpoch) {
        const [rows, _fields] = await this.pool.execute('SELECT * FROM `latest` WHERE `address` = :address',  { address });

        if (rows.length > 0) {
            assert(rows.length == 1);

            if (rows[0].name !== name) {
                console.log(`Warning: duplicate address in DB, updating from ${rows[0].name} to ${name}`.bold.red);
                await this.pool.execute('UPDATE `latest` SET `name` = :name WHERE `address` = :address', { name, address });
            }

            return rows[0].latest;
        }

        // insert if not present
        await this.pool.execute('INSERT INTO `latest` VALUES (:name, :address, :earliest, :latest)', {
            name,
            address,
            earliest: creationEpoch,
            latest: creationEpoch - 1,
        });

        return creationEpoch - 1;
    }

    async storeEpochLogs(epoch, address, logs) {
        const conn = await this.pool.getConnection();
        await conn.beginTransaction();

        for (const log of logs) {
            assert(log.epochNumber == epoch);

            await conn.execute('INSERT INTO `events` VALUES (:epoch, :blockHash, :address, :topic0, :topic1, :topic2, :topic3, :raw)', {
                epoch,
                blockHash: log.blockHash,
                address: log.address,
                topic0: log.topics[0],
                topic1: log.topics[1] || null,
                topic2: log.topics[2] || null,
                topic3: log.topics[3] || null,
                raw: JSON.stringify(log),
            });
        }

        await conn.execute('UPDATE `latest` SET `latest` = :epoch WHERE `address` = :address', { epoch, address });
        await conn.commit();
        conn.release();
    }

    async getLogs(args) {
        const [rows] = await this.pool.query(`
            SELECT raw FROM events WHERE

            -- epoch number
                (:from IS NULL OR epoch >= :from)
            AND (:to IS NULL OR epoch <= :to)

            -- address
            AND (:address IS NULL OR address = :address)

            -- topics
            AND (:noTopic0 OR topic0 IN (:topic0))
            AND (:noTopic1 OR topic1 IN (:topic1))
            AND (:noTopic2 OR topic2 IN (:topic2))
            AND (:noTopic3 OR topic3 IN (:topic3))`,
            {
                from: args.fromEpoch ? Number(args.fromEpoch) : null,
                to: args.toEpoch ? Number(args.toEpoch) : null,
                address: args.address ? format.address(format.hexAddress(args.address), 1, true) : null, // TODO: use network ID
                noTopic0: !args.topics || !args.topics[0],
                topic0: args.topics && args.topics[0] || null,
                noTopic1: !args.topics || !args.topics[1],
                topic1: args.topics && args.topics[1] || null,
                noTopic2: !args.topics || !args.topics[2],
                topic2: args.topics && args.topics[2] || null,
                noTopic3: !args.topics || !args.topics[3],
                topic3: args.topics && args.topics[3] || null,
            }
        );

        return rows.map(r => JSON.parse(r.raw));
    }

    async close() {
        await this.pool.end();
    }
}

module.exports = Database;