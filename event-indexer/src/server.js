const _colors = require('colors');
const jayson = require('jayson/promise');
const cors = require('cors');
const morgan = require('morgan');
const express = require('express');
const jsonParser = require('body-parser').json;

const Database = require('./database');

function startServer(db, port) {
    const app = express();

    // assign unique ID to request
    let id = 1;

    app.use((req, _res, next) => {
        req.id = id;
        id += 1;
        next();
    });

    // parse body
    app.use(jsonParser());

    // set up logging
    morgan.token('id', req => req.id);
    morgan.token('body', req => JSON.stringify(req.body));

    app.use(morgan('--> :id [:date] ":method :url" --  :body', { immediate: true }))
    app.use(morgan('<-- :id [:date] :status :response-time ms :res[content-length] bytes', { immediate: false }))

    // enable CORS including pre-flight requests
    app.options('*', cors());
    app.use(cors());

    // set up JSON-RPC server
    const server = jayson.server({
        cfx_getLogs: async function(args) {
            return await db.getLogs(args[0]);
        }
    });

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

    // start RPC server
    const PORT = 3000;
    startServer(db, PORT);
    console.log(`Server listening on port ${PORT}`);
}

main();

