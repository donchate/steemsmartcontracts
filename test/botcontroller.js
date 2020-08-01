/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const fs = require('fs-extra');
const BigNumber = require('bignumber.js');
const { Base64 } = require('js-base64');
const { MongoClient } = require('mongodb');


const { Database } = require('../libs/Database');
const blockchain = require('../plugins/Blockchain');
const { Transaction } = require('../libs/Transaction');

const { CONSTANTS } = require('../libs/Constants');

const conf = {
  chainId: "test-chain-id",
  genesisSteemBlock: 2000000,
  dataDirectory: "./test/data/",
  databaseFileName: "database.db",
  autosaveInterval: 0,
  javascriptVMTimeout: 10000,
  databaseURL: "mongodb://localhost:27017",
  databaseName: "testssc",
  streamNodes: ["https://api.steemit.com"],
};

let plugins = {};
let jobs = new Map();
let currentJobId = 0;
let database1 = null;

function send(pluginName, from, message) {
  const plugin = plugins[pluginName];
  const newMessage = {
    ...message,
    to: plugin.name,
    from,
    type: 'request',
  };
  currentJobId += 1;
  newMessage.jobId = currentJobId;
  plugin.cp.send(newMessage);
  return new Promise((resolve) => {
    jobs.set(currentJobId, {
      message: newMessage,
      resolve,
    });
  });
}


// function to route the IPC requests
const route = (message) => {
  const { to, type, jobId } = message;
  if (to) {
    if (to === 'MASTER') {
      if (type && type === 'request') {
        // do something
      } else if (type && type === 'response' && jobId) {
        const job = jobs.get(jobId);
        if (job && job.resolve) {
          const { resolve } = job;
          jobs.delete(jobId);
          resolve(message);
        }
      }
    } else if (type && type === 'broadcast') {
      plugins.forEach((plugin) => {
        plugin.cp.send(message);
      });
    } else if (plugins[to]) {
      plugins[to].cp.send(message);
    } else {
      console.error('ROUTING ERROR: ', message);
    }
  }
};

const loadPlugin = (newPlugin) => {
  const plugin = {};
  plugin.name = newPlugin.PLUGIN_NAME;
  plugin.cp = fork(newPlugin.PLUGIN_PATH, [], { silent: true });
  plugin.cp.on('message', msg => route(msg));
  plugin.cp.stdout.on('data', data => console.log(`[${newPlugin.PLUGIN_NAME}]`, data.toString()));
  plugin.cp.stderr.on('data', data => console.error(`[${newPlugin.PLUGIN_NAME}]`, data.toString()));

  plugins[newPlugin.PLUGIN_NAME] = plugin;

  return send(newPlugin.PLUGIN_NAME, 'MASTER', { action: 'init', payload: conf });
};

const unloadPlugin = (plugin) => {
  plugins[plugin.PLUGIN_NAME].cp.kill('SIGINT');
  plugins[plugin.PLUGIN_NAME] = null;
  jobs = new Map();
  currentJobId = 0;
}

// prepare tokens contract for deployment
let contractCode = fs.readFileSync('./contracts/tokens.js');
contractCode = contractCode.toString();
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_PRECISION\}\$'/g, CONSTANTS.UTILITY_TOKEN_PRECISION);
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);
contractCode = contractCode.replace(/'\$\{CONSTANTS.HIVE_PEGGED_SYMBOL\}\$'/g, CONSTANTS.HIVE_PEGGED_SYMBOL);
let base64ContractCode = Base64.encode(contractCode);

let tknContractPayload = {
  name: 'tokens',
  params: '',
  code: base64ContractCode,
};

// prepare market contract for deployment
contractCode = fs.readFileSync('./contracts/market.js');
contractCode = contractCode.toString();
base64ContractCode = Base64.encode(contractCode);

let mktContractPayload = {
  name: 'market',
  params: '',
  code: base64ContractCode,
};

// prepare bot controller contract for deployment
contractCode = fs.readFileSync('./contracts/botcontroller.js');
contractCode = contractCode.toString();
base64ContractCode = Base64.encode(contractCode);

let bcContractPayload = {
  name: 'botcontroller',
  params: '',
  code: base64ContractCode,
};

// prepare market maker contract for deployment
contractCode = fs.readFileSync('./contracts/marketmaker.js');
contractCode = contractCode.toString();
base64ContractCode = Base64.encode(contractCode);

let mmContractPayload = {
  name: 'marketmaker',
  params: '',
  code: base64ContractCode,
};

const getUsers = async (db) => {
  const users = await db.find({
    contract: 'botcontroller',
    table: 'users',
    query: {},
    indexes: [{index: '_id', descending: false}],
  });
  return users;
};

const getMarkets = async (db) => {
  const markets = await db.find({
    contract: 'botcontroller',
    table: 'markets',
    query: {},
    indexes: [{index: '_id', descending: false}],
  });
  return markets;
};

const assertFields = (user, fields) => {
  const {
    account,
    isPremium,
    isOnCooldown,
    isEnabled,
    lastTickBlock,
    timeLimit,
    markets,
    enabledMarkets,
  } = fields;

  console.log(user);

  assert.equal(user.account, account );
  assert.equal(user.isPremium, isPremium );
  assert.equal(user.isOnCooldown, isOnCooldown );
  assert.equal(user.isEnabled, isEnabled );
  assert.equal(user.lastTickBlock, lastTickBlock );
  assert.equal(user.timeLimit, timeLimit );

  if(markets !== undefined) {
    assert.equal(user.markets, markets );
  }

  if(enabledMarkets !== undefined) {
    assert.equal(user.enabledMarkets, enabledMarkets );
  }
};

const assertMarketFields = (market, fields) => {
  const {
    account,
    symbol,
    isEnabled,
  } = fields;

  assert.equal(market.account, account );
  assert.equal(market.symbol, symbol );
  assert.equal(market.isEnabled, isEnabled );

  console.log(market);
};

// botcontroller
describe('botcontroller', function() {
  this.timeout(200000);

  before((done) => {
    new Promise(async (resolve) => {
      client = await MongoClient.connect(conf.databaseURL, { useNewUrlParser: true });
      db = await client.db(conf.databaseName);
      await db.dropDatabase();
      resolve();
    })
      .then(() => {
        done()
      })
  });
  
  after((done) => {
    new Promise(async (resolve) => {
      await client.close();
      resolve();
    })
      .then(() => {
        done()
      })
  });

  beforeEach((done) => {
    new Promise(async (resolve) => {
      db = await client.db(conf.databaseName);
      resolve();
    })
      .then(() => {
        done()
      })
  });

  afterEach((done) => {
      // runs after each test in this block
      new Promise(async (resolve) => {
        await db.dropDatabase()
        resolve();
      })
        .then(() => {
          done()
        })
  });

  it('ticks accounts', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let startRefBlockNum = 45251625;
      let transactions = [];
      transactions.push(new Transaction(startRefBlockNum, 'TXID1230A', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1230B', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1230C', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(bcContractPayload)));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1231', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(mmContractPayload)));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "cryptomancer", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "aggroed", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "beggars", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1235', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'botcontroller', 'updateParams', '{ "basicFee": "100", "basicSettingsFee": "1", "premiumFee": "100", "premiumBaseStake": "1000", "stakePerMarket": "200", "basicDurationBlocks": 10, "basicCooldownBlocks": 10, "basicMinTickIntervalBlocks": 5, "premiumMinTickIntervalBlocks": 3, "basicMaxTicksPerBlock": 1, "premiumMaxTicksPerBlock": 2 }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1236', 'cryptomancer', 'botcontroller', 'register', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1237', 'aggroed', 'botcontroller', 'register', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1238', 'beggars', 'botcontroller', 'register', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1239', 'beggars', 'tokens', 'stake', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "beggars", "quantity": "1400", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1240', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "2000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1241', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "url": "https://token.com", "symbol": "TESTNFT", "precision": 3, "maxSupply": "2000", "isSignedWithActiveKey": true }'));

      // make sure beggars has plenty of tokens to market make with
      transactions.push(new Transaction(startRefBlockNum, 'TXID1242', CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "beggars", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1243', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "to": "beggars", "quantity": "700", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1244', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TESTNFT", "to": "beggars", "quantity": "800", "isSignedWithActiveKey": true }'));

      // setup buy order book with several orders
      transactions.push(new Transaction(startRefBlockNum, 'TXID1245', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "to": "satoshi", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1246', CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "vitalik", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1247', CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "nakamoto", "quantity": "500", "isSignedWithActiveKey": true }'));

      transactions.push(new Transaction(startRefBlockNum, 'TXID1248', 'vitalik', 'market', 'buy', '{ "symbol": "TKN", "quantity": "10", "price": "0.734", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1249', 'beggars', 'market', 'buy', '{ "symbol": "TKN", "quantity": "12", "price": "0.720", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1250', 'beggars', 'market', 'buy', '{ "symbol": "TKN", "quantity": "15", "price": "0.710", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1251', 'nakamoto', 'market', 'buy', '{ "symbol": "TKN", "quantity": "20", "price": "0.634", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1252', 'vitalik', 'market', 'buy', '{ "symbol": "TKN", "quantity": "30", "price": "0.534", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1253', 'nakamoto', 'market', 'buy', '{ "symbol": "TKN", "quantity": "40", "price": "0.434", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1254', 'vitalik', 'market', 'buy', '{ "symbol": "TKN", "quantity": "50", "price": "0.334", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1255', 'nakamoto', 'market', 'buy', '{ "symbol": "TKN", "quantity": "60", "price": "0.234", "isSignedWithActiveKey": true }'));

      // setup sell order book with several orders
      transactions.push(new Transaction(startRefBlockNum, 'TXID1256', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "10", "price": "0.784", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1257', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "20", "price": "0.784", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1258', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "20", "price": "0.784", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1259', 'beggars', 'market', 'sell', '{ "symbol": "TKN", "quantity": "15", "price": "0.784", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1260', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "20", "price": "0.794", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1261', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "30", "price": "0.804", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1262', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "40", "price": "0.814", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1263', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "50", "price": "0.824", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(startRefBlockNum, 'TXID1264', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "60", "price": "0.834", "isSignedWithActiveKey": true }'));

      let blockTimestamp = new Date('2018-06-01T00:00:00').getTime();
      let block = {
        refHiveBlockNumber: startRefBlockNum,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: new Date(blockTimestamp).toString(),
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // process a bunch of blocks and verify accounts tick OK
      let numBlocks = 0;
      for(let i = 0; i < 100; i += 1) {
        numBlocks += 1;
        startRefBlockNum += 1;
        transactions = [];
        // dummy transaction just to generate a block
        transactions.push(new Transaction(startRefBlockNum, 'TXID9999' + i.toString(), 'aggroed', 'whatever', 'whatever', '{ "isSignedWithActiveKey": true }'));

        switch(numBlocks) {
          case 8:
            // test that turning off an account works OK
            transactions.push(new Transaction(startRefBlockNum, 'TXIDA000' + i.toString(), 'cryptomancer', 'botcontroller', 'turnOff', '{ "isSignedWithActiveKey": true }'));
            break;
          case 15:
            // test that you can't re-enable an account that is in cooldown
            transactions.push(new Transaction(startRefBlockNum, 'TXIDB000' + i.toString(), 'aggroed', 'botcontroller', 'turnOn', '{ "isSignedWithActiveKey": true }'));
            break;
          case 30:
            // test that turning on an account works OK
            transactions.push(new Transaction(startRefBlockNum, 'TXIDC000' + i.toString(), 'cryptomancer', 'botcontroller', 'turnOn', '{ "isSignedWithActiveKey": true }'));
            break;
          case 35:
            // test premium upgrade and turning back on after a cooldown expires
            transactions.push(new Transaction(startRefBlockNum, 'TXIDD000' + i.toString(), 'aggroed', 'botcontroller', 'turnOn', '{ "isSignedWithActiveKey": true }'));
            transactions.push(new Transaction(startRefBlockNum, 'TXIDD001' + i.toString(), 'beggars', 'botcontroller', 'upgrade', '{ "isSignedWithActiveKey": true }'));
            transactions.push(new Transaction(startRefBlockNum, 'TXIDD002' + i.toString(), 'beggars', 'botcontroller', 'turnOn', '{ "isSignedWithActiveKey": true }'));
            break;
          case 36:
            // add a couple markets
            transactions.push(new Transaction(startRefBlockNum, 'TXIDE000' + i.toString(), 'beggars', 'botcontroller', 'addMarket', '{ "symbol": "TKN", "isSignedWithActiveKey": true }'));
            transactions.push(new Transaction(startRefBlockNum, 'TXIDE001' + i.toString(), 'beggars', 'botcontroller', 'addMarket', '{ "symbol": "TESTNFT", "isSignedWithActiveKey": true }'));
            break;
          case 39:
            // unstake some tokens (should cause markets to be disabled as staking requirement no longer met)
            transactions.push(new Transaction(startRefBlockNum, 'TXIDF000' + i.toString(), 'beggars', 'tokens', 'unstake', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));
            break;
          case 42:
            // test that market can't be re-enabled if staking requirement not met
            transactions.push(new Transaction(startRefBlockNum, 'TXIDG000' + i.toString(), 'beggars', 'botcontroller', 'enableMarket', '{ "symbol": "TKN", "isSignedWithActiveKey": true }'));
          default:
            break;
        }

        blockTimestamp += 3000; // assume a perfect 3 second block time so we can count by blocks
        block = {
          refHiveBlockNumber: startRefBlockNum,
          refHiveBlockId: 'ABCD1',
          prevRefHiveBlockId: 'ABCD2',
          timestamp: new Date(blockTimestamp).toString(),
          transactions,
        };

        await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

        // verify account state updates OK after each tick
        let users = await getUsers(database1);
        let markets = await getMarkets(database1);
        let blockInfo = await database1.getBlockInfo(numBlocks + 1);
        let transactionData = blockInfo.transactions;
        switch(numBlocks) {
          case 1:
            console.log('ticking: ' + numBlocks);
            assertFields(users[0], { account: 'cryptomancer', isPremium: false, isOnCooldown: false, isEnabled: true, lastTickBlock: 1, timeLimit: 10 * 3 * 1000 });
            assertFields(users[1], { account: 'aggroed',      isPremium: false, isOnCooldown: false, isEnabled: true, lastTickBlock: 1, timeLimit: 10 * 3 * 1000 });
            assertFields(users[2], { account: 'beggars',      isPremium: false, isOnCooldown: false, isEnabled: true, lastTickBlock: 1, timeLimit: 10 * 3 * 1000});
            break;
          case 5:
            console.log('ticking: ' + numBlocks);
            assertFields(users[0], { account: 'cryptomancer', isPremium: false, isOnCooldown: false, isEnabled: true, lastTickBlock: 6, timeLimit: 5 * 3 * 1000 });
            assertFields(users[1], { account: 'aggroed',      isPremium: false, isOnCooldown: false, isEnabled: true, lastTickBlock: 1, timeLimit: 10 * 3 * 1000 });
            assertFields(users[2], { account: 'beggars',      isPremium: false, isOnCooldown: false, isEnabled: true, lastTickBlock: 1, timeLimit: 10 * 3 * 1000 });
            break;
          case 6:
            console.log('ticking: ' + numBlocks);
            assertFields(users[0], { account: 'cryptomancer', isPremium: false, isOnCooldown: false, isEnabled: true, lastTickBlock: 6, timeLimit: 5 * 3 * 1000 });
            assertFields(users[1], { account: 'aggroed',      isPremium: false, isOnCooldown: false, isEnabled: true, lastTickBlock: 7, timeLimit: 4 * 3 * 1000 });
            assertFields(users[2], { account: 'beggars',      isPremium: false, isOnCooldown: false, isEnabled: true, lastTickBlock: 1, timeLimit: 10 * 3 * 1000 });
            break;
          case 7:
            console.log('ticking: ' + numBlocks);
            assertFields(users[0], { account: 'cryptomancer', isPremium: false, isOnCooldown: false, isEnabled: true, lastTickBlock: 6, timeLimit: 5 * 3 * 1000 });
            assertFields(users[1], { account: 'aggroed',      isPremium: false, isOnCooldown: false, isEnabled: true, lastTickBlock: 7, timeLimit: 4 * 3 * 1000 });
            assertFields(users[2], { account: 'beggars',      isPremium: false, isOnCooldown: false, isEnabled: true, lastTickBlock: 8, timeLimit: 3 * 3 * 1000 });
            break;
          case 8: // cryptomancer executes a turnOff action here
            console.log('ticking: ' + numBlocks);
            assertFields(users[0], { account: 'cryptomancer', isPremium: false, isOnCooldown: false, isEnabled: false, lastTickBlock: 9, timeLimit: 2 * 3 * 1000 });
            assertFields(users[1], { account: 'aggroed',      isPremium: false, isOnCooldown: false, isEnabled: true,  lastTickBlock: 7, timeLimit: 4 * 3 * 1000 });
            assertFields(users[2], { account: 'beggars',      isPremium: false, isOnCooldown: false, isEnabled: true,  lastTickBlock: 8, timeLimit: 3 * 3 * 1000 });
            break;
          case 11: // aggroed ticks and goes into cooldown
            console.log('ticking: ' + numBlocks);
            assertFields(users[0], { account: 'cryptomancer', isPremium: false, isOnCooldown: false, isEnabled: false, lastTickBlock: 9,  timeLimit: 2 * 3 * 1000 });
            assertFields(users[1], { account: 'aggroed',      isPremium: false, isOnCooldown: true,  isEnabled: false, lastTickBlock: 12, timeLimit: 0 * 3 * 1000 });
            assertFields(users[2], { account: 'beggars',      isPremium: false, isOnCooldown: false, isEnabled: true,  lastTickBlock: 8,  timeLimit: 3 * 3 * 1000 });
            break;
          case 12: // beggars ticks and goes into cooldown
            console.log('ticking: ' + numBlocks);
            assertFields(users[0], { account: 'cryptomancer', isPremium: false, isOnCooldown: false, isEnabled: false, lastTickBlock: 9,  timeLimit: 2 * 3 * 1000 });
            assertFields(users[1], { account: 'aggroed',      isPremium: false, isOnCooldown: true,  isEnabled: false, lastTickBlock: 12, timeLimit: 0 * 3 * 1000 });
            assertFields(users[2], { account: 'beggars',      isPremium: false, isOnCooldown: true,  isEnabled: false, lastTickBlock: 13, timeLimit: 0 * 3 * 1000 });
            break;
          case 15: // aggroed tries to re-enable, but can't because he's on cooldown
            console.log('ticking: ' + numBlocks);
            console.log(transactionData[1].logs);
            assert.equal(JSON.parse(transactionData[1].logs).errors[0], 'cooldown duration not expired');
            break;
          case 25: // verify state isn't changing while accounts are turned off
            console.log('ticking: ' + numBlocks);
            assertFields(users[0], { account: 'cryptomancer', isPremium: false, isOnCooldown: false, isEnabled: false, lastTickBlock: 9,  timeLimit: 2 * 3 * 1000 });
            assertFields(users[1], { account: 'aggroed',      isPremium: false, isOnCooldown: true,  isEnabled: false, lastTickBlock: 12, timeLimit: 0 * 3 * 1000 });
            assertFields(users[2], { account: 'beggars',      isPremium: false, isOnCooldown: true,  isEnabled: false, lastTickBlock: 13, timeLimit: 0 * 3 * 1000 });
            break;
          case 30: // cryptomancer executes a turnOn action here
            console.log('ticking: ' + numBlocks);
            assertFields(users[0], { account: 'cryptomancer', isPremium: false, isOnCooldown: false, isEnabled: true,  lastTickBlock: 31, timeLimit: 2 * 3 * 1000 });
            assertFields(users[1], { account: 'aggroed',      isPremium: false, isOnCooldown: true,  isEnabled: false, lastTickBlock: 12, timeLimit: 0 * 3 * 1000 });
            assertFields(users[2], { account: 'beggars',      isPremium: false, isOnCooldown: true,  isEnabled: false, lastTickBlock: 13, timeLimit: 0 * 3 * 1000 });
            break;
          case 35: // cryptomancer ticks and goes into cooldown, aggroed does a turnOn, beggars does an upgrade
            console.log('ticking: ' + numBlocks);
            assertFields(users[0], { account: 'cryptomancer', isPremium: false, isOnCooldown: true,  isEnabled: false, lastTickBlock: 36, timeLimit: 0 * 3 * 1000 });
            assertFields(users[1], { account: 'aggroed',      isPremium: false, isOnCooldown: false, isEnabled: true,  lastTickBlock: 36, timeLimit: 10 * 3 * 1000 });
            assertFields(users[2], { account: 'beggars',      isPremium: true,  isOnCooldown: false, isEnabled: true,  lastTickBlock: 36, timeLimit: 10 * 3 * 1000 });
            break;
          case 36: // beggars adds 2 markets
            console.log('ticking: ' + numBlocks);
            assertFields(users[0], { account: 'cryptomancer', isPremium: false, isOnCooldown: true,  isEnabled: false, lastTickBlock: 36, timeLimit: 0 * 3 * 1000 });
            assertFields(users[1], { account: 'aggroed',      isPremium: false, isOnCooldown: false, isEnabled: true,  lastTickBlock: 36, timeLimit: 10 * 3 * 1000 });
            assertFields(users[2], { account: 'beggars',      isPremium: true,  isOnCooldown: false, isEnabled: true,  lastTickBlock: 36, timeLimit: 10 * 3 * 1000, markets: 2, enabledMarkets: 2 });
            assertMarketFields(markets[0], { account: 'beggars', symbol: 'TKN',     isEnabled: true });
            assertMarketFields(markets[1], { account: 'beggars', symbol: 'TESTNFT', isEnabled: true });
            break;
          case 38: // beggars is premium so should tick faster than the other two, and markets should stay enabled
            console.log('ticking: ' + numBlocks);
            assertFields(users[0], { account: 'cryptomancer', isPremium: false, isOnCooldown: true,  isEnabled: false, lastTickBlock: 36, timeLimit: 0 * 3 * 1000 });
            assertFields(users[1], { account: 'aggroed',      isPremium: false, isOnCooldown: false, isEnabled: true,  lastTickBlock: 36, timeLimit: 10 * 3 * 1000 });
            assertFields(users[2], { account: 'beggars',      isPremium: true,  isOnCooldown: false, isEnabled: true,  lastTickBlock: 39, timeLimit: 10 * 3 * 1000, markets: 2, enabledMarkets: 2 });
            assertMarketFields(markets[0], { account: 'beggars', symbol: 'TKN',     isEnabled: true });
            assertMarketFields(markets[1], { account: 'beggars', symbol: 'TESTNFT', isEnabled: true });
            // check market orders - beggars should have orders added by the bot
            let buyOrders = await database1.find({
              contract: 'market',
              table: 'buyBook',
              query: {
                account: { $in: ['beggars'] }
              },
              indexes: [{index: '_id', descending: false}],
            });
            console.log(buyOrders);
            console.log(blockInfo);
            break;
          case 39: // beggars unstakes 100 tokens
            console.log('ticking: ' + numBlocks);
            console.log(transactionData[1].logs);
            assert.equal(JSON.parse(transactionData[1].logs).events[0].event, 'unstakeStart');
            break;
          case 40: // aggroed ticks, nothing else changes
            console.log('ticking: ' + numBlocks);
            assertFields(users[0], { account: 'cryptomancer', isPremium: false, isOnCooldown: true,  isEnabled: false, lastTickBlock: 36, timeLimit: 0 * 3 * 1000 });
            assertFields(users[1], { account: 'aggroed',      isPremium: false, isOnCooldown: false, isEnabled: true,  lastTickBlock: 41, timeLimit: 5 * 3 * 1000 });
            assertFields(users[2], { account: 'beggars',      isPremium: true,  isOnCooldown: false, isEnabled: true,  lastTickBlock: 39, timeLimit: 10 * 3 * 1000, markets: 2, enabledMarkets: 2 });
            assertMarketFields(markets[0], { account: 'beggars', symbol: 'TKN',     isEnabled: true });
            assertMarketFields(markets[1], { account: 'beggars', symbol: 'TESTNFT', isEnabled: true });
            break;
          case 41: // beggars ticks, stays premium but markets disabled because staked tokens have gone down from 1400 to 1300
            console.log('ticking: ' + numBlocks);
            assertFields(users[0], { account: 'cryptomancer', isPremium: false, isOnCooldown: true,  isEnabled: false, lastTickBlock: 36, timeLimit: 0 * 3 * 1000 });
            assertFields(users[1], { account: 'aggroed',      isPremium: false, isOnCooldown: false, isEnabled: true,  lastTickBlock: 41, timeLimit: 5 * 3 * 1000 });
            assertFields(users[2], { account: 'beggars',      isPremium: true,  isOnCooldown: false, isEnabled: true,  lastTickBlock: 42, timeLimit: 10 * 3 * 1000, markets: 2, enabledMarkets: 0 });
            assertMarketFields(markets[0], { account: 'beggars', symbol: 'TKN',     isEnabled: false });
            assertMarketFields(markets[1], { account: 'beggars', symbol: 'TESTNFT', isEnabled: false });
            break;
          case 42: // beggars tries to re-enable market, but can't because he no longer meets the staking requirement
            console.log('ticking: ' + numBlocks);
            console.log(transactionData[1].logs);
            assert.equal(JSON.parse(transactionData[1].logs).errors[0], `must stake more ${CONSTANTS.UTILITY_TOKEN_SYMBOL} to enable market`);
            assertMarketFields(markets[0], { account: 'beggars', symbol: 'TKN',     isEnabled: false });
            assertMarketFields(markets[1], { account: 'beggars', symbol: 'TESTNFT', isEnabled: false });
            break;
          default:
            break;
        }
      }

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('updates parameters', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(bcContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'botcontroller', 'updateParams', '{ "basicFee": "1", "basicSettingsFee": "2", "premiumFee": "3", "premiumBaseStake": "999", "stakePerMarket": "50", "basicDurationBlocks": 100, "basicCooldownBlocks": 150, "basicMinTickIntervalBlocks": 200, "premiumMinTickIntervalBlocks": 250, "basicMaxTicksPerBlock": 5, "premiumMaxTicksPerBlock": 10 }'));

      let block = {
        refHiveBlockNumber: 38145386,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[0].logs);

      // check if the params updated OK
      const params = await database1.findOne({
        contract: 'botcontroller',
        table: 'params',
        query: {}
      });

      console.log(params);

      assert.equal(params.basicFee, '1');
      assert.equal(params.basicSettingsFee, '2');
      assert.equal(params.premiumFee, '3');
      assert.equal(params.premiumBaseStake, '999');
      assert.equal(params.stakePerMarket, '50');
      assert.equal(params.basicDurationBlocks, 100);
      assert.equal(params.basicCooldownBlocks, 150);
      assert.equal(params.basicMinTickIntervalBlocks, 200);
      assert.equal(params.premiumMinTickIntervalBlocks, 250);
      assert.equal(params.basicMaxTicksPerBlock, 5);
      assert.equal(params.premiumMaxTicksPerBlock, 10);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('rejects invalid parameters', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(bcContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'aggroed', 'botcontroller', 'updateParams', '{ "basicFee": "1", "basicSettingsFee": "2", "premiumFee": "3", "premiumBaseStake": "999", "stakePerMarket": "50", "basicDurationBlocks": 100, "basicCooldownBlocks": 150 }'));
      transactions.push(new Transaction(38145386, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'botcontroller', 'updateParams', '{ "wrongKey": "oops"  }'));
      transactions.push(new Transaction(38145386, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'botcontroller', 'updateParams', '{ "basicCooldownBlocks": "150" }'));

      let block = {
        refHiveBlockNumber: 38145386,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // params should not have changed from their initial values
      const params = await database1.findOne({
        contract: 'botcontroller',
        table: 'params',
        query: {}
      });

      console.log(params);

      assert.equal(params.basicFee, '100');
      assert.equal(params.basicSettingsFee, '1');
      assert.equal(params.premiumFee, '100');
      assert.equal(params.premiumBaseStake, '1000');
      assert.equal(params.stakePerMarket, '200');
      assert.equal(params.basicDurationBlocks, 403200);
      assert.equal(params.basicCooldownBlocks, 403200);
      assert.equal(params.basicMinTickIntervalBlocks, 200);
      assert.equal(params.premiumMinTickIntervalBlocks, 100);
      assert.equal(params.basicMaxTicksPerBlock, 20);
      assert.equal(params.premiumMaxTicksPerBlock, 30);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('upgrades a user to premium and adds multiple markets', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(bcContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TESTNFT", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "ATOKEN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1235', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "cryptomancer", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(38145386, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'botcontroller', 'updateParams', '{ "basicFee": "100", "basicSettingsFee": "1", "premiumFee": "100", "premiumBaseStake": "1000", "stakePerMarket": "200", "basicDurationBlocks": 100, "basicCooldownBlocks": 100, "basicMaxTicksPerBlock": 5, "premiumMaxTicksPerBlock": 10 }'));
      transactions.push(new Transaction(38145386, 'TXID1237', 'cryptomancer', 'botcontroller', 'register', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1238', 'cryptomancer', 'tokens', 'stake', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "cryptomancer", "quantity": "1400", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(38145386, 'TXID1239', 'cryptomancer', 'botcontroller', 'upgrade', '{ "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 38145386,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // check if the user was registered OK
      let user = await database1.findOne({
        contract: 'botcontroller',
        table: 'users',
        query: {}
      });

      console.log(user);

      assert.equal(user.account, 'cryptomancer');
      assert.equal(user.isPremium, true );
      assert.equal(user.isPremiumFeePaid, true );
      assert.equal(user.isOnCooldown, false );
      assert.equal(user.isEnabled, true );
      assert.equal(user.markets, 0 );
      assert.equal(user.timeLimit, 100 * 3 * 1000);
      assert.equal(user.lastTickTimestamp, 1527811200000);
      assert.equal(user.lastTickBlock, 1);
      assert.equal(user.creationTimestamp, 1527811200000);
      assert.equal(user.creationBlock, 1);

      // verify registration fee has been burned
      const balances = await database1.find({
        contract: 'tokens',
        table: 'balances',
        query: {
          symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL,
          account: { $in: ['null', 'cryptomancer'] }
        },
        indexes: [{index: '_id', descending: false}],
      });

      console.log(balances);

      assert.equal(balances[0].account, 'null');
      assert.equal(balances[0].symbol, CONSTANTS.UTILITY_TOKEN_SYMBOL);
      assert.equal(balances[0].balance, 500);
      assert.equal(balances[1].account, 'cryptomancer');
      assert.equal(balances[1].symbol, CONSTANTS.UTILITY_TOKEN_SYMBOL);
      assert.equal(balances[1].balance, 400);
      assert.equal(balances[1].stake, 1400);

      // add a couple markets
      transactions = [];
      transactions.push(new Transaction(38145387, 'TXID1240', 'cryptomancer', 'botcontroller', 'addMarket', '{ "symbol": "TKN", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1241', 'cryptomancer', 'botcontroller', 'addMarket', '{ "symbol": "TESTNFT", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 38145387,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // verify markets have been added
      user = await database1.findOne({
        contract: 'botcontroller',
        table: 'users',
        query: {}
      });
      assert.equal(user.markets, 2 );

      let markets = await database1.find({
        contract: 'botcontroller',
        table: 'markets',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      console.log(markets);
      assert.equal(markets.length, 2 );
      assert.equal(markets[0].symbol, 'TKN' );
      assert.equal(markets[1].symbol, 'TESTNFT' );

      // verify failure conditions
      transactions = [];
      transactions.push(new Transaction(38145388, 'TXID1242', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "aggroed", "quantity": "1100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(38145388, 'TXID1243', 'cryptomancer', 'botcontroller', 'upgrade', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145388, 'TXID1244', 'cryptomancer', 'botcontroller', 'upgrade', '{ "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(38145388, 'TXID1245', 'aggroed', 'botcontroller', 'upgrade', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145388, 'TXID1246', 'aggroed', 'tokens', 'stake', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "aggroed", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(38145388, 'TXID1247', 'aggroed', 'botcontroller', 'upgrade', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145388, 'TXID1248', 'aggroed', 'botcontroller', 'register', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145388, 'TXID1249', 'aggroed', 'botcontroller', 'upgrade', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1250', 'cryptomancer', 'botcontroller', 'addMarket', '{ "symbol": "ATOKEN", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 38145388,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const block3 = await database1.getBlockInfo(3);
      const transactionsBlock3 = block3.transactions;

      console.log(transactionsBlock3[1].logs);
      console.log(transactionsBlock3[2].logs);
      console.log(transactionsBlock3[3].logs);
      console.log(transactionsBlock3[5].logs);
      console.log(transactionsBlock3[7].logs);
      console.log(transactionsBlock3[8].logs);

      assert.equal(JSON.parse(transactionsBlock3[1].logs).errors[0], 'user is already premium');
      assert.equal(JSON.parse(transactionsBlock3[2].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock3[3].logs).errors[0], 'you do not have enough tokens staked');
      assert.equal(JSON.parse(transactionsBlock3[5].logs).errors[0], 'user not registered');
      assert.equal(JSON.parse(transactionsBlock3[7].logs).errors[0], 'you must have enough tokens to cover the premium upgrade fee');
      assert.equal(JSON.parse(transactionsBlock3[8].logs).errors[0], 'must stake more BEE to add a market');

      // make sure user aggroed was NOT upgraded
      user = await database1.findOne({
        contract: 'botcontroller',
        table: 'users',
        query: { account: 'aggroed' }
      });

      console.log(user);

      assert.equal(user.account, 'aggroed');
      assert.equal(user.isPremium, false );
      assert.equal(user.isPremiumFeePaid, false );

      // verify a third market was NOT added
      user = await database1.findOne({
        contract: 'botcontroller',
        table: 'users',
        query: {'account': 'cryptomancer'}
      });
      assert.equal(user.markets, 2 );

      markets = await database1.find({
        contract: 'botcontroller',
        table: 'markets',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      assert.equal(markets.length, 2 );
      assert.equal(markets[0].symbol, 'TKN' );
      assert.equal(markets[1].symbol, 'TESTNFT' );

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('registers a new user and adds a market', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(bcContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TESTNFT", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "cryptomancer", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'botcontroller', 'updateParams', '{ "basicFee": "100", "basicSettingsFee": "1", "premiumFee": "100", "premiumBaseStake": "1000", "stakePerMarket": "200", "basicDurationBlocks": 100, "basicCooldownBlocks": 100, "basicMaxTicksPerBlock": 5, "premiumMaxTicksPerBlock": 10 }'));
      transactions.push(new Transaction(38145386, 'TXID1236', 'cryptomancer', 'tokens', 'stake', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "cryptomancer", "quantity": "200", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(38145386, 'TXID1237', 'cryptomancer', 'botcontroller', 'register', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1238', 'cryptomancer', 'botcontroller', 'addMarket', '{ "symbol": "TKN", "isSignedWithActiveKey": true, "maxBidPrice": "15.12345678", "minSellPrice": "20.87654321", "maxBaseToSpend": "666", "maxTokensToSell": "50", "minTokensToSell": "5", "minSpread": "0.01" }'));
      transactions.push(new Transaction(38145386, 'TXID1239', 'cryptomancer', 'botcontroller', 'updateMarket', '{ "symbol": "TKN", "isSignedWithActiveKey": true, "minBaseToSpend": "111", "priceIncrement": "0.011" }'));

      let block = {
        refHiveBlockNumber: 38145386,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const block1 = await database1.getBlockInfo(1);
      const transactionsBlock1 = block1.transactions;

      console.log(transactionsBlock1[8].logs);
      console.log(transactionsBlock1[9].logs);

      // verify registration fee has been burned
      const balances = await database1.find({
        contract: 'tokens',
        table: 'balances',
        query: {
          symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL,
          account: { $in: ['null', 'cryptomancer'] }
        },
        indexes: [{index: '_id', descending: false}],
      });

      console.log(balances);

      assert.equal(balances[0].account, 'null');
      assert.equal(balances[0].symbol, CONSTANTS.UTILITY_TOKEN_SYMBOL);
      assert.equal(balances[0].balance, 301);
      assert.equal(balances[1].account, 'cryptomancer');
      assert.equal(balances[1].symbol, CONSTANTS.UTILITY_TOKEN_SYMBOL);
      assert.equal(balances[1].balance, 699);
      assert.equal(balances[1].stake, 200);

      // verify failure conditions
      transactions = [];
      transactions.push(new Transaction(38145387, 'TXID1240', 'cryptomancer', 'botcontroller', 'register', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1241', 'cryptomancer', 'botcontroller', 'register', '{ "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(38145387, 'TXID1242', 'aggroed', 'botcontroller', 'register', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1243', 'cryptomancer', 'botcontroller', 'addMarket', '{ "symbol": "TKN", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(38145387, 'TXID1244', 'cryptomancer', 'botcontroller', 'addMarket', '{ "symbol": 123, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1245', 'cryptomancer', 'botcontroller', 'addMarket', '{ "symbol": "SWAP.HIVE", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1246', 'aggroed', 'botcontroller', 'addMarket', '{ "symbol": "TKN", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1247', 'cryptomancer', 'botcontroller', 'addMarket', '{ "symbol": "INVALID", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1248', 'cryptomancer', 'botcontroller', 'addMarket', '{ "symbol": "TKN", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1249', 'cryptomancer', 'botcontroller', 'addMarket', '{ "symbol": "TESTNFT", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1250', 'cryptomancer', 'botcontroller', 'removeMarket', '{ "symbol": "INVALID", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 38145387,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const block2 = await database1.getBlockInfo(2);
      const transactionsBlock2 = block2.transactions;

      console.log(transactionsBlock2[0].logs);
      console.log(transactionsBlock2[1].logs);
      console.log(transactionsBlock2[2].logs);
      console.log(transactionsBlock2[3].logs);
      console.log(transactionsBlock2[4].logs);
      console.log(transactionsBlock2[5].logs);
      console.log(transactionsBlock2[6].logs);
      console.log(transactionsBlock2[7].logs);
      console.log(transactionsBlock2[8].logs);
      console.log(transactionsBlock2[9].logs);
      console.log(transactionsBlock2[10].logs);

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'user already registered');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'you must have enough tokens to cover the registration fee');
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock2[4].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[5].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[6].logs).errors[0], 'user not registered');
      assert.equal(JSON.parse(transactionsBlock2[7].logs).errors[0], 'symbol must exist');
      assert.equal(JSON.parse(transactionsBlock2[8].logs).errors[0], 'market already added');
      assert.equal(JSON.parse(transactionsBlock2[9].logs).errors[0], 'not allowed to add another market');
      assert.equal(JSON.parse(transactionsBlock2[10].logs).errors[0], 'market must exist');

      // check if the user was registered OK and no additional markets
      // were added from above failures
      let user = await database1.findOne({
        contract: 'botcontroller',
        table: 'users',
        query: {}
      });

      console.log(user);

      assert.equal(user.account, 'cryptomancer');
      assert.equal(user.isPremium, false );
      assert.equal(user.isPremiumFeePaid, false );
      assert.equal(user.isOnCooldown, false );
      assert.equal(user.isEnabled, true );
      assert.equal(user.markets, 1 );
      assert.equal(user.enabledMarkets, 1 );
      assert.equal(user.timeLimit, 100 * 3 * 1000);
      assert.equal(user.lastTickTimestamp, 1527811200000);
      assert.equal(user.lastTickBlock, 1);
      assert.equal(user.creationTimestamp, 1527811200000);
      assert.equal(user.creationBlock, 1);

      // check if the market was added OK and not affected by above failures
      let market = await database1.findOne({
        contract: 'botcontroller',
        table: 'markets',
        query: {}
      });

      console.log(market);

      assert.equal(market.account, 'cryptomancer');
      assert.equal(market.symbol, 'TKN');
      assert.equal(market.precision, 3);
      assert.equal(market.strategy, 1);
      assert.equal(market.maxBidPrice, '15.12345678');
      assert.equal(market.minSellPrice, '20.87654321');
      assert.equal(market.maxBaseToSpend, '666');
      assert.equal(market.minBaseToSpend, '111');
      assert.equal(market.maxTokensToSell, '50');
      assert.equal(market.minTokensToSell, '5');
      assert.equal(market.priceIncrement, '0.011');
      assert.equal(market.minSpread, '0.01');
      assert.equal(market.isEnabled, true);
      assert.equal(market.creationTimestamp, 1527811200000);
      assert.equal(market.creationBlock, 1);

      // disable the market
      transactions = [];
      transactions.push(new Transaction(38145388, 'TXID1251', 'cryptomancer', 'botcontroller', 'disableMarket', '{ "symbol": "TKN", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 38145388,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // verify the market is disabled
      user = await database1.findOne({
        contract: 'botcontroller',
        table: 'users',
        query: {'account': 'cryptomancer'}
      });
      assert.equal(user.markets, 1 );
      assert.equal(user.enabledMarkets, 0 );

      market = await database1.findOne({
        contract: 'botcontroller',
        table: 'markets',
        query: {}
      });
      assert.equal(market.isEnabled, false );

      // re-enable the market
      transactions = [];
      transactions.push(new Transaction(38145389, 'TXID1252', 'cryptomancer', 'botcontroller', 'enableMarket', '{ "symbol": "TKN", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 38145389,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // verify the market is re-enabled
      user = await database1.findOne({
        contract: 'botcontroller',
        table: 'users',
        query: {'account': 'cryptomancer'}
      });
      assert.equal(user.markets, 1 );
      assert.equal(user.enabledMarkets, 1 );

      market = await database1.findOne({
        contract: 'botcontroller',
        table: 'markets',
        query: {}
      });
      assert.equal(market.isEnabled, true );

      // remove the market
      transactions = [];
      transactions.push(new Transaction(38145390, 'TXID1253', 'cryptomancer', 'botcontroller', 'removeMarket', '{ "symbol": "TKN", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 38145390,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // verify the market is gone
      user = await database1.findOne({
        contract: 'botcontroller',
        table: 'users',
        query: {'account': 'cryptomancer'}
      });
      assert.equal(user.markets, 0 );
      assert.equal(user.enabledMarkets, 0 );

      market = await database1.find({
        contract: 'botcontroller',
        table: 'markets',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      assert.equal(market.length, 0 );

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });
});