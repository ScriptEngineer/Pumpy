// CommonJS Imports
const { Keypair, Connection, Transaction, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const RaydiumSDK = require('@raydium-io/raydium-sdk'); // Import Raydium SDK
const express = require('express');
const { json } = require('body-parser');
const fetch = require('isomorphic-fetch');
const bs58 = require('bs58').default; 
const { post } = require('axios');
require('dotenv').config(); // Load environment variables

const { LIQUIDITY_PROGRAM_ID_V4 } = RaydiumSDK;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const JITO_API_KEY = process.env.JITO_API_KEY; // If Jito requires an API key
const JITO_ENDPOINT = process.env.JITO_ENDPOINT || 'https://api.jito.wtf/';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Base58 encoded
const BUY_AMOUNT_SOL = parseFloat(process.env.BUY_AMOUNT_SOL) || 1; // Amount of SOL to spend on the meme coin
const MEME_COIN_CRITERIA = process.env.MEME_COIN_CRITERIA
  ? process.env.MEME_COIN_CRITERIA.split(',')
  : ['meme', 'doge', 'shiba', 'inu'];

// Load wallet
if (!PRIVATE_KEY) {
  throw new Error('WALLET_PRIVATE_KEY is not set in environment variables');
}

// Correct usage of decode from bs58
const secretKey = bs58.decode(PRIVATE_KEY);
const wallet = Keypair.fromSecretKey(secretKey);

// Express app setup
const app = express();
app.use(json());

// Retry logic for network calls
async function retry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

// Function to detect if the token is a meme coin
function isMemeCoin(tokenMetadata) {
  const name = tokenMetadata.name ? tokenMetadata.name.toLowerCase() : '';
  const symbol = tokenMetadata.symbol ? symbol.toLowerCase() : '';
  const description = tokenMetadata.description
    ? tokenMetadata.description.toLowerCase()
    : '';
  return MEME_COIN_CRITERIA.some(
    (keyword) =>
      name.includes(keyword) ||
      symbol.includes(keyword) ||
      description.includes(keyword)
  );
}

// Function to fetch token metadata with fallback and retry
async function getTokenMetadata(mintAddress) {
  const solscanUrl = `https://public-api.solscan.io/token/meta?tokenAddress=${mintAddress}`;
  try {
    const response = await fetch(solscanUrl, { timeout: 5000 });
    if (response.ok) {
      return await response.json();
    }
    console.error(`Error fetching metadata, Status: ${response.status}`);
  } catch (error) {
    console.error('Error fetching token metadata:', error);
  }
  return {}; // Default to an empty object if the request fails
}

// Swap logic integrated with Raydium SDK
async function createSwapInstruction({ poolKeys, userSourceTokenAccount, userDestinationTokenAccount, amountIn }) {
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

  // Use Raydium SDK to create swap instruction
  const swapInstruction = await Liquidity.makeSwapInstructionSimple({
    connection,
    poolKeys,
    userKeys: {
      tokenAccounts: {
        base: userSourceTokenAccount,
        quote: userDestinationTokenAccount,
      },
      owner: wallet.publicKey,
    },
    amountIn,
    amountOut: 0, // Use slippage tolerance here
    fixedSide: 'base', // Fixed-side token to swap from
  });

  return swapInstruction;
}

// Function to execute buy order using Jito bundles
async function buyMemeCoin(poolInfo) {
  const memeCoinMint = poolInfo.tokenMint;
  const poolKeys = poolInfo.poolKeys;  // Assuming poolKeys is passed with the pool data

  // Initialize connections
  const standardConnection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const jitoConnection = new Connection(JITO_ENDPOINT, 'confirmed');

  // Placeholder: User's MEME token account (actual logic to get/create token account needed)
  const memeCoinAccount = new PublicKey('YOUR_DESTINATION_MEME_TOKEN_ACCOUNT_PUBLIC_KEY');

  // Create transaction with actual swap logic
  const transaction = new Transaction();
  const swapInstruction = await createSwapInstruction({
    poolKeys,
    userSourceTokenAccount: wallet.publicKey, // User SOL account
    userDestinationTokenAccount: memeCoinAccount, // Destination MEME token account
    amountIn: BUY_AMOUNT_SOL * LAMPORTS_PER_SOL, // Amount in SOL
  });
  transaction.add(swapInstruction);

  // Fetch recent blockhash from the standard connection
  const recentBlockhash = (await standardConnection.getRecentBlockhash()).blockhash;
  transaction.recentBlockhash = recentBlockhash;
  transaction.feePayer = wallet.publicKey;
  transaction.sign(wallet);

  // Serialize the transaction
  const serializedTransaction = transaction.serialize();

  // Prepare the bundle for Jito
  const bundle = {
    transactions: [serializedTransaction.toString('base64')],
  };

  // Send the bundle to Jito with retry logic
  try {
    const response = await retry(() =>
      post(`${JITO_ENDPOINT}/bundle`, bundle, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${JITO_API_KEY}`,
        },
      })
    );
    console.log(`Transaction bundle submitted via Jito:`, response.data);
  } catch (error) {
    console.error(
      'Error submitting transaction bundle via Jito:',
      error.response ? error.response.data : error.message
    );
  }
}

// Endpoint to receive webhooks from Helius
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body[0];

    console.log(data);

    if (data.source == "RAYDIUM") { 
        console.log("RAYDIUM LIQUID POOL CREATED");

        const accountData = data.accountData;
        console.log("Account data: ");
        accountData.forEach(dta => {
            console.log(dta);
        })

        const instructions = data.instructions;
        console.log("Instructions: ");
        instructions.forEach(inst => {
            console.log(inst);
        });

        const tokenTransfers = data.tokenTransfers;
        console.log("Token transfers: ");
        tokenTransfers.forEach(transfer => {
            console.log(transfer);
        });

    }

    res.status(200).send('Received');

  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Error');
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server is listening on port ${PORT}`);
});
