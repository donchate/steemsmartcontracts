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
let base64ContractCode = Base64.encode(contractCode);

let tknContractPayload = {
  name: 'tokens',
  params: '',
  code: base64ContractCode,
};

// prepare nft contract for deployment
contractCode = fs.readFileSync('./contracts/nft.js');
contractCode = contractCode.toString();
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);
base64ContractCode = Base64.encode(contractCode);

let nftContractPayload = {
  name: 'nft',
  params: '',
  code: base64ContractCode,
};

// prepare crittermanager contract for deployment
contractCode = fs.readFileSync('./contracts/crittermanager.js');
contractCode = contractCode.toString();
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);
base64ContractCode = Base64.encode(contractCode);

let critterContractPayload = {
  name: 'crittermanager',
  params: '',
  code: base64ContractCode,
};
console.log(critterContractPayload);

// crittermanager
describe('crittermanager', function() {
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

  it('updates parameters', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'deploy', JSON.stringify(critterContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'cryptomancer', 'crittermanager', 'updateParams', `{ "editionMapping": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":1,"ALPHA":2,"BETA":3,"UNTAMED":4} }`));

      let block = {
        refSteemBlockNumber: 38145386,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // TODO: get rid of this block later once contract code is finalized
      const block1 = await database1.getBlockInfo(1);
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[0].logs)

      // check if the params updated OK
      const params = await database1.findOne({
        contract: 'crittermanager',
        table: 'params',
        query: {}
      });

      console.log(params);

      assert.equal(JSON.stringify(params.editionMapping), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":1,"ALPHA":2,"BETA":3,"UNTAMED":4}`);

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
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'deploy', JSON.stringify(critterContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'aggroed', 'crittermanager', 'updateParams', `{ "editionMapping": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":1,"ALPHA":2,"BETA":3,"UNTAMED":4} }`));
      transactions.push(new Transaction(38145386, 'TXID1232', 'cryptomancer', 'crittermanager', 'updateParams', `{ "wrongKey": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":1,"ALPHA":2,"BETA":3,"UNTAMED":4} }`));
      transactions.push(new Transaction(38145386, 'TXID1233', 'cryptomancer', 'crittermanager', 'updateParams', `{ "editionMapping": 666 }`));

      let block = {
        refSteemBlockNumber: 38145386,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // params should not have changed from their initial values
      const params = await database1.findOne({
        contract: 'crittermanager',
        table: 'params',
        query: {}
      });

      console.log(params);

      assert.equal(JSON.stringify(params.editionMapping), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":1,"ALPHA":2,"BETA":3}`);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('sets up the NFT', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(critterContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "5" }'));
      transactions.push(new Transaction(38145386, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'cryptomancer', 'crittermanager', 'createNft', '{ "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 38145386,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // check if the NFT was created OK
      const token = await database1.findOne({
        contract: 'nft',
        table: 'nfts',
        query: { symbol: 'CRITTER' }
      });

      console.log(token);

      assert.equal(token.symbol, 'CRITTER');
      assert.equal(token.issuer, 'cryptomancer');
      assert.equal(token.name, 'Mischievous Crypto Critters');
      assert.equal(token.maxSupply, 0);
      assert.equal(token.supply, 0);
      assert.equal(JSON.stringify(token.authorizedIssuingContracts), '["crittermanager"]');
      assert.equal(token.circulatingSupply, 0);
      assert.equal(token.delegationEnabled, false);
      assert.equal(token.undelegationCooldown, 0);
      
      const properties = token.properties;

      assert.equal(properties.edition.type, "number");
      assert.equal(properties.edition.isReadOnly, true);
      assert.equal(properties.type.type, "number");
      assert.equal(properties.type.isReadOnly, true);
      assert.equal(properties.rarity.type, "number");
      assert.equal(properties.rarity.isReadOnly, true);
      assert.equal(properties.isGoldFoil.type, "boolean");
      assert.equal(properties.isGoldFoil.isReadOnly, true);
      assert.equal(properties.name.type, "string");
      assert.equal(properties.name.isReadOnly, false);
      assert.equal(properties.xp.type, "number");
      assert.equal(properties.xp.isReadOnly, false);
      assert.equal(properties.hp.type, "number");
      assert.equal(properties.hp.isReadOnly, false);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not set up the NFT', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(critterContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "5" }'));
      transactions.push(new Transaction(38145386, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'aggroed', 'crittermanager', 'createNft', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1236', 'cryptomancer', 'crittermanager', 'createNft', '{ "isSignedWithActiveKey": false }'));

      let block = {
        refSteemBlockNumber: 38145386,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // verify NFT was not created
      const token = await database1.findOne({
        contract: 'nft',
        table: 'nfts',
        query: { symbol: 'CRITTER' }
      });

      console.log(token);
      assert.equal(token, null);

      const block1 = await database1.getBlockInfo(1);
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[6].logs)

      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'you must use a custom_json signed with your active key');

      // test that you can't create CRITTER twice
      transactions = [];
      transactions.push(new Transaction(38145387, 'TXID1237', 'cryptomancer', 'crittermanager', 'createNft', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1238', 'cryptomancer', 'crittermanager', 'createNft', '{ "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 38145387,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const block2 = await database1.getBlockInfo(2);
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[1].logs)

      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'CRITTER already exists');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('hatches critters', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(critterContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "dataPropertyCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"} }`));
      transactions.push(new Transaction(38145386, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"1000", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'steemsc', 'tokens', 'transferToContract', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"crittermanager", "quantity":"1000", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1236', 'cryptomancer', 'crittermanager', 'createNft', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1237', 'cryptomancer', 'crittermanager', 'hatch', `{ "isSignedWithActiveKey": true, "packSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "packs": 100 }`));

      let block = {
        refSteemBlockNumber: 38145386,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // check if the expected amount of critters were issued
      const token = await database1.findOne({
        contract: 'nft',
        table: 'nfts',
        query: { symbol: 'CRITTER' }
      });

      console.log(token);

      assert.equal(token.supply, 500);
      assert.equal(token.circulatingSupply, 500);

      // check if the critters were issued OK
      const instances = await database1.find({
        contract: 'nft',
        table: 'CRITTERinstances',
        query: {}
      });

      console.log(instances);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });
});
