// CommonJS Imports
const {
  Keypair,
  Connection,
  Transaction,
  PublicKey,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
} = require('@solana/spl-token');
const RaydiumSDK = require('@raydium-io/raydium-sdk');
const { Liquidity, NATIVE_SOL } = RaydiumSDK;
const express = require('express');
const { json } = require('body-parser');
const axios = require('axios');
const bs58 = require('bs58').default;
require('dotenv').config(); // Load environment variables
const BN = require('bn.js'); // BigNumber library for handling large integers

const JITO_ENDPOINT = process.env.JITO_ENDPOINT || 'https://api.jito.wtf/';
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Base58 encoded
const BUY_AMOUNT_SOL = parseFloat(process.env.BUY_AMOUNT_SOL) || 1; // Amount of SOL to spend on the meme coin

// Load wallet
if (!PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY is not set in environment variables');
}

const secretKey = bs58.decode(PRIVATE_KEY);
const wallet = Keypair.fromSecretKey(secretKey);

// Express app setup
const app = express();
app.use(json());

// Function to fetch token metadata with fallback and retry
async function getTokenMetadata(mintAddress) {
  const solscanUrl = `https://public-api.solscan.io/token/meta?tokenAddress=${mintAddress}`;
  try {
    const response = await axios.get(solscanUrl, { timeout: 5000 });
    return response.data;
  } catch (error) {
    console.error('Error fetching token metadata:', error.message);
  }
  return {}; // Default to an empty object if the request fails
}

// Endpoint to receive webhooks from Raydium
app.post('/ray', async (req, res) => {
  try {
    const data = req.body[0];

    if (data.source === 'RAYDIUM') {
      console.log('RAYDIUM LIQUIDITY POOL CREATED');

      const tokenTransfers = data.tokenTransfers;
      const newTokenMint = tokenTransfers[0].mint;
      console.log('New token mint: ', newTokenMint);
      const tokenMetadata = await getTokenMetadata(newTokenMint);

      console.log('Detected a meme coin!');

      // Fetch pool keys using Raydium SDK
      const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
      const allPools = await Liquidity.fetchAllPoolKeys(connection);
      const poolInfo = Object.values(allPools).find((pool) =>
          (pool.baseMint.equals(new PublicKey(newTokenMint)) &&
            pool.quoteMint.equals(NATIVE_SOL.mint)) ||
          (pool.quoteMint.equals(new PublicKey(newTokenMint)) &&
            pool.baseMint.equals(NATIVE_SOL.mint))
      );

      if (poolInfo) {
        console.log('Found liquidity pool for the meme coin');
        await buyToken(newTokenMint, null, "raydium");

      } else {
        console.log('No liquidity pool found for the meme coin');
      }

    }

    res.status(200).send('Received');
  } catch (error) {
    console.error('Error processing /ray webhook:', error.message);
    res.status(500).send('Error');
  }
});

// Endpoint to receive webhooks from Pump Fun
app.post('/pumpkins', async (req, res) => {
  try {

    let initialSol = 0;
    let initialTokens = 0;
    
    const data = req.body[0];
    const tokenMint = data.tokenTransfers[0].mint;

    console.log(data);
    console.log('PUMP FUN POOL CREATED');
    console.log('Token Mint: ', tokenMint);

    data.nativeTransfers.forEach((transfer) => {
      if (transfer.amount > initialSol) {
        initialSol = transfer.amount / LAMPORTS_PER_SOL;
      }
    });

    data.tokenTransfers.forEach((transfer) => {
      if (transfer.tokenAmount > initialTokens) {
        initialTokens = transfer.tokenAmount;
      }
    });

    console.log('Initial SOL Liquidity: ', initialSol);
    console.log('Initial Tokens Liquidity: ', initialTokens);

    await buyToken(tokenMint, "pump_fun");

    res.status(200).send('Received');
    
  } catch (error) {
    console.error('Error processing /pumpkins webhook:', error.message);
    res.status(500).send('Error');
  }
});

async function buyToken(tokenMint, poolAddress = null, exchange = "raydium") {
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const mintAddress = new PublicKey(tokenMint);

  // Get or create associated token account for the target token (Pump Fun or Meme Coin)
  const tokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    wallet,
    mintAddress,
    wallet.publicKey
  );

  // Amount in SOL, converted to lamports
  const amountInLamports = new BN(BUY_AMOUNT_SOL * LAMPORTS_PER_SOL);

  // Fetch pool keys depending on the exchange
  let poolKeys;
  if (exchange === "pump_fun") {

    if (!poolAddress) {
      console.error("Pump Fun pool address is required for Pump Fun exchange.");
      return;
    }
    // Use predefined Pump Fun pool address
    poolKeys = await Liquidity.fetchPoolKeysByPoolId(
      connection,
      new PublicKey(poolAddress)
    );

  } else if (exchange === "raydium") {

    // For meme coins, fetch all pools and find the relevant one
    const allPools = await Liquidity.fetchAllPoolKeys(connection);
    poolKeys = Object.values(allPools).find(
      (pool) =>
        (pool.baseMint.equals(mintAddress) &&
          pool.quoteMint.equals(NATIVE_SOL.mint)) ||
        (pool.quoteMint.equals(mintAddress) &&
          pool.baseMint.equals(NATIVE_SOL.mint))
    );

  } else {
    console.error(`Unknown exchange: ${exchange}`);
    return;
  }

  if (!poolKeys) {
    console.error('Could not find pool keys for the token');
    return;
  }

  // Create swap transaction
  const { transaction, signers } = await Liquidity.makeSwapTransaction({
    connection,
    poolKeys,
    userKeys: {
      owner: wallet.publicKey,
      tokenAccounts: {
        input: wallet.publicKey, // User's SOL account
        output: tokenAccount.address, // Token account for Pump Fun or meme coin
      },
    },
    amountIn: amountInLamports,
    amountOut: new BN(0), 
    fixedSide: 'in',
  });

  transaction.feePayer = wallet.publicKey;

  // Fetch recent blockhash
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.sign(wallet, ...signers);

  // Add tip instruction to incentivize processing
  addTipInstruction(transaction);

  // Serialize the transaction
  const serializedTransaction = transaction.serialize();
  const base58EncodedTransaction = serializedTransaction.toString('base58');

  // Send the bundle to Jito
  await sendBundleToJito([base58EncodedTransaction]);
}

async function sendBundleToJito(transactions) {
  try {
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [transactions]
    };

    const response = await axios.post(JITO_ENDPOINT, payload, {
      headers: { 'Content-Type': 'application/json' }
    });

    console.log('Bundle submitted to Jito: ', response.data);
  } catch (error) {
    console.error('Error submitting bundle to Jito: ', error.message);
  }
}

function addTipInstruction(transaction) {
  const tipAccount = new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'); // Random tip account
  const tipAmountLamports = 1000; // Minimum required tip (adjust as needed)

  const tipInstruction = SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: tipAccount,
    lamports: tipAmountLamports,
  });

  transaction.add(tipInstruction);
}

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server is listening on port ${PORT}`);
});
