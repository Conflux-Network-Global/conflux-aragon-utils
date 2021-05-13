const _colors = require('colors');
const jayson = require('jayson/promise');
const cors = require('cors');
const morgan = require('morgan');
const express = require('express');
const jsonParser = require('body-parser').json;

const Database = require('./database');

function startServer(db, port) {
    const app = express();

    const server = jayson.server({
        cfx_getLogs: async function(args) {
            return await db.getLogs(args[0]);
        }
    });

    morgan.token('body', (req, res) => JSON.stringify(req.body));
    app.use(morgan(':method :url :status :response-time ms - :res[content-length] :body - :req[content-length]'));

    // enable CORS including pre-flight requests
    app.options('*', cors());
    app.use(cors());

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
        'database': 'db2',
    });

    // make sure to close db on exit
    process.stdin.resume();
    process.on('exit', async () => { db.close(); process.exit(); });
    process.on('SIGINT', async () => { db.close(); process.exit(); });
    process.on('SIGUSR1', async () => { db.close(); process.exit(); });
    process.on('SIGUSR2', async () => { db.close(); process.exit(); });
    process.on('uncaughtException', async (r) => { console.error(r); db.close(); process.exit(); });

    // start RPC server
    startServer(db, 3000);
}

main();

