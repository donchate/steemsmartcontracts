const CONSTANTS = {

  // mainnet

  UTILITY_TOKEN_SYMBOL: 'BEE',
  GOVERNANCE_TOKEN_SYMBOL: 'WORKERBEE',
  HIVE_ENGINE_ACCOUNT: 'hive-engine',
  HIVE_PEGGED_ACCOUNT: 'honey-swap',
  INITIAL_TOKEN_CREATION_FEE: '100',
  INITIAL_DELEGATION_ENABLEMENT_FEE: '1000',
  INITIAL_STAKING_ENABLEMENT_FEE: '1000',
  SSC_STORE_QTY: '0.00100000',

  // testnet
  /*
  UTILITY_TOKEN_SYMBOL: 'BEE',
  HIVE_PEGGED_ACCOUNT: 'hive-engine',
  INITIAL_TOKEN_CREATION_FEE: '0',
  INITIAL_DELEGATION_ENABLEMENT_FEE: '0',
  INITIAL_STAKING_ENABLEMENT_FEE: '0',
  SSC_STORE_QTY: '1',
  */
  UTILITY_TOKEN_PRECISION: 8,
  GOVERNANCE_TOKEN_PRECISION: 5,
  GOVERNANCE_TOKEN_MIN_VALUE: '0.00001',
  HIVE_PEGGED_SYMBOL: 'SWAP.HIVE',

  // default values
  ACCOUNT_RECEIVING_FEES: 'hive-engine',
  SSC_STORE_PRICE: '0.001',
};

module.exports.CONSTANTS = CONSTANTS;
