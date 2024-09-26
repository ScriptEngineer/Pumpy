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

const PORT = process.env.PORT || 3000;
const JITO_ENDPOINT = process.env.JITO_ENDPOINT || 'https://api.jito.wtf/';
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Base58 encoded
const BUY_AMOUNT_SOL = parseFloat(process.env.BUY_AMOUNT_SOL) || 1; // Amount of SOL to spend on the meme coin

// Load wallet
if (!PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY is not set in environment variables');
}

const secretKey = bs58.decode(PRIVATE_KEY);
const wallet = Keypair.fromSecretKey(secretKey);

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

async function mainMenu() {
  const { select, input, Separator } = await import('@inquirer/prompts');
  
  const answer = await select({
    message: 'Main Menu',
    choices: [
      new Separator(),
      {
        name: 'Buy Token',
        value: 'buy_token',
        description: 'Buy a token from Raydium or Pump Fun',
      },
      {
        name: 'Sell Token',
        value: 'sell_token',
        description: 'Sell a token from Raydium or Pump Fun',
      },
      {
        name: 'Start Sniper',
        value: 'start_sniper',
        description: 'Start Pumping!',
      },
      {
        name: 'Get Token Metadata',
        value: 'token_metadata',
        description: 'Get token information',
      },
      {
        name: 'Exit',
        value: 'exit'
      },
      new Separator(),
    ],
  });

  if (answer === 'buy_token' || answer === 'sell_token') {
    // Ask the user for the token address
    const tokenMint = await input({
      message: 'Please enter the token address (mint):',
      validate(value) {
        const valid = value.length === 44 || value.length === 43;
        return valid || 'Please enter a valid Solana token address.';
      }
    });

    if (answer === 'buy_token') {
      await swapToken(tokenMint, null, 'raydium', 'buy', true);
    } else if (answer === 'sell_token') {
      await swapToken(tokenMint, null, 'raydium', 'sell', true);
    }

    await mainMenu(); // Re-run menu after Buy/Sell

  } else if (answer === 'start_sniper') {
    // Start the sniper and do not re-run the menu
    await startSniper();

  } else if (answer === 'token_metadata') {

    const tokenMint = await input({
      message: 'Please enter the token address (mint) to fetch metadata:',
      validate(value) {
        const valid = value.length === 44 || value.length === 43;
        return valid || 'Please enter a valid Solana token address.';
      }
    });
    const metadata = await getTokenMetadata(tokenMint);
    console.log(metadata);

    await mainMenu(); // Re-run menu after metadata fetch

  } else if (answer === 'exit') {
    console.log('Exiting...');
    process.exit(0);
  }
}


async function swapToken(
  tokenMint,
  poolAddress = null,
  exchange = 'raydium',
  direction = 'sell',
  USE_JITO = false
) {
  const connection = new Connection(RPC_URL, 'confirmed');
  const mintAddress = new PublicKey(tokenMint);

  // Get or create associated token account for the token
  const tokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    wallet,
    mintAddress,
    wallet.publicKey
  );

  // Fetch pool keys depending on the exchange
  let poolKeys;
  if (exchange === 'pump_fun') {
    if (!poolAddress) {
      console.error('Pump Fun pool address is required for Pump Fun exchange.');
      return;
    }
    // Use predefined Pump Fun pool address
    poolKeys = await Liquidity.fetchPoolKeysByPoolId(
      connection,
      new PublicKey(poolAddress)
    );
  } else if (exchange === 'raydium') {
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

  let inputAccount;
  let outputAccount;
  let amountIn;

  if (direction === 'buy') {
    // For buying, input is SOL, output is token
    inputAccount = wallet.publicKey; // User's SOL account
    outputAccount = tokenAccount.address; // User's token account

    // Amount in SOL, converted to lamports
    amountIn = new BN(BUY_AMOUNT_SOL * LAMPORTS_PER_SOL);
  } else if (direction === 'sell') {
    // For selling, input is token, output is SOL
    inputAccount = tokenAccount.address; // User's token account
    outputAccount = wallet.publicKey; // User's SOL account

    // Fetch the amount of tokens to sell (balance in the token account)
    const tokenAccountInfo = await connection.getTokenAccountBalance(
      tokenAccount.address
    );
    amountIn = new BN(tokenAccountInfo.value.amount);

    if (amountIn.isZero()) {
      console.error('No tokens to sell');
      return;
    }
  } else {
    console.error(`Invalid direction: ${direction}`);
    return;
  }

  // Create swap transaction
  const { transaction, signers } = await Liquidity.makeSwapTransaction({
    connection,
    poolKeys,
    userKeys: {
      owner: wallet.publicKey,
      tokenAccounts: {
        input: inputAccount,
        output: outputAccount,
      },
    },
    amountIn: amountIn,
    amountOut: new BN(0),
    fixedSide: 'in',
  });

  transaction.feePayer = wallet.publicKey;

  if (USE_JITO) {
    // Add tip instruction to incentivize processing
    addTipInstruction(transaction);
  }

  // Fetch recent blockhash
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;

  // Sign the transaction
  transaction.sign(wallet, ...signers);

  if (USE_JITO) {
    // Serialize the transaction
    const serializedTransaction = transaction.serialize();
    const base58EncodedTransaction = serializedTransaction.toString('base58');

    // Send the bundle to Jito
    await sendBundleToJito([base58EncodedTransaction]);
  } else {
    // Send the transaction via standard Solana RPC
    try {
      const txid = await sendAndConfirmTransaction(
        connection,
        transaction,
        [wallet, ...signers],
        { commitment: 'confirmed' }
      );
      console.log(`${direction.charAt(0).toUpperCase() + direction.slice(1)} transaction sent:`, txid);
    } catch (error) {
      console.error(`Error sending ${direction} transaction:`, error.message);
    }
  }
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

async function startSniper() {
  try {

    console.log("");
    const app = express();
    app.use(json());

    app.listen(PORT, async () => {
      console.log(`Firing up on port ${PORT}...`);
    });

    app.post('/', async (req, res) => {  
      console.log("TESTER TESTING");
      res.status(200).send('Received');
    });

    app.post('/ray', async (req, res) => {
      try {
        const data = req.body[0];

        if (data.source === 'RAYDIUM') {
          console.log('RAYDIUM LIQUIDITY POOL CREATED');

          console.log(data);
          const tokenTransfers = data.tokenTransfers;
          const newTokenMint = tokenTransfers[0].mint;
          console.log('New token mint: ', newTokenMint);
          const tokenMetadata = await getTokenMetadata(newTokenMint);

          console.log('Detected a meme coin!');

          // Fetch pool keys using Raydium SDK
          const connection = new Connection(RPC_URL, 'confirmed');
          const allPools = await Liquidity.fetchAllPoolKeys(connection);
          const poolInfo = Object.values(allPools).find((pool) =>
              (pool.baseMint.equals(new PublicKey(newTokenMint)) &&
                pool.quoteMint.equals(NATIVE_SOL.mint)) ||
              (pool.quoteMint.equals(new PublicKey(newTokenMint)) &&
                pool.baseMint.equals(NATIVE_SOL.mint))
          );

          /*
          if (poolInfo) {
            console.log('Found liquidity pool for the meme coin');
            await swapToken(newTokenMint, null, 'raydium', 'buy', true);
            console.log(`Scheduling to sell the token in ${SELL_DELAY_MS / 1000} seconds.`);
            setTimeout(async () => {
              console.log('Attempting to sell the token now.');
              await swapToken(newTokenMint, poolInfo.id, 'raydium', 'sell', USE_JITO_FOR_SELL);
            }, SELL_DELAY_MS);
          } else {
            console.log('No liquidity pool found for the meme coin');
          }
          */

        }

        res.status(200).send('Received');
      } catch (error) {
        console.error('Error processing /ray webhook:', error.message);
        res.status(500).send('Error');
      }
    });

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

        /*
        await swapToken(tokenMint, 'pump_fun', 'pump_fun', 'buy', true);

        console.log(`Scheduling to sell the token in ${SELL_DELAY_MS / 1000} seconds.`);
        setTimeout(async () => {
          console.log('Attempting to sell the token now.');
          await swapToken(tokenMint, 'pump_fun', 'pump_fun', 'sell', USE_JITO_FOR_SELL);
        }, SELL_DELAY_MS);
        */

        res.status(200).send('Received');
        
      } catch (error) {
        console.error('Error processing /pumpkins webhook:', error.message);
        res.status(500).send('Error');
      }
    });

  } catch (error) {
    console.error('Error starting sniper:', error.message);
  }
}

(async () => {
  try {

    console.log(`\nUsing RPC URL:\n${RPC_URL}`);
    console.log(`\nPumping with: \n${PRIVATE_KEY}\n\n`);
    await mainMenu();

  } catch (error) {
    console.error('Error:', error.message);
  }
})();

