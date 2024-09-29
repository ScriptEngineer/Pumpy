const fs = require('fs'); 
const {
  Keypair,
  Connection,
  Transaction,
  PublicKey,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  SystemProgram,
} = require('@solana/web3.js');

const {
  getOrCreateAssociatedTokenAccount,
  createInitializeAccountInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  ACCOUNT_SIZE, // Import ACCOUNT_SIZE constant
} = require('@solana/spl-token');

const {
  Liquidity,
  LIQUIDITY_POOLS,
  LIQUIDITY_PROGRAM_ID_V4,
  LIQUIDITY_STATE_LAYOUT_V4,
  TokenAmount,
  Percent,
} = require('@raydium-io/raydium-sdk');

const JSONStream = require('JSONStream'); 
const express = require('express');
const { json } = require('body-parser');
const axios = require('axios');
const bs58 = require('bs58').default;
require('dotenv').config(); // Load environment variables
const BN = require('bn.js'); // BigNumber library for handling large integers

const PORT = process.env.PORT || 3000;
const JITO_ENDPOINT = process.env.JITO_ENDPOINT || 'https://api.jito.wtf/';
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Base58 encoded
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
if (!PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY is not set in environment variables');
}

const secretKey = bs58.decode(PRIVATE_KEY);
const wallet = Keypair.fromSecretKey(secretKey);
const connection = new Connection(RPC_URL, 'confirmed');
//const RAYDIUM_AMM_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_SWAP_PROGRAM = '5quB2RnXqpVpDwFETegxYGrvp3pCHNRtT5Rt6r5wNKS';
const tokenBought = false;

async function writeJsonToFile(jsonData, filePath) {
  try {
    const writeStream = fs.createWriteStream(filePath);

    writeStream.write(JSON.stringify(jsonData, null, 2)); // Pretty prints the JSON with indentation
    writeStream.end(); // Closes the stream

    writeStream.on('finish', () => {
      console.log(`${filePath} written successfully.`);
    });

    writeStream.on('error', (error) => {
      console.error(`Error writing ${filePath}:`, error);
    });

  } catch (error) {
    console.error(`Failed to write JSON to file: ${error.message}`);
  }
}

async function writeLargeJsonToFile(jsonData, filePath) {
  try {
    const writeStream = fs.createWriteStream(filePath);
    const jsonStream = JSONStream.stringify('[\n', ',\n', '\n]\n');

    jsonStream.pipe(writeStream);

    for (const data of jsonData) {
      jsonStream.write(data); // Write each object to the stream
    }

    jsonStream.end(); // Finish the stream

    jsonStream.on('end', () => {
      console.log(`${filePath} written successfully.`);
    });

    writeStream.on('error', (error) => {
      console.error(`Error writing ${filePath}:`, error);
    });

  } catch (error) {
    console.error(`Failed to write JSON to file: ${error.message}`);
  }
}

async function getTokenMetadata(mintAddress) {
  const heliusUrl = `https://api.helius.xyz/v0/tokens/metadata?api-key=${process.env.HELIUS_API_KEY}`;  // API URL with your Helius API key

  try {
    // Prepare the request payload
    const data = {
      mintAccounts: [mintAddress]
    };

    // Make the API call to Helius
    const response = await axios.post(heliusUrl, data, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

    // Check if the response contains data
    if (response.data && response.data.length > 0) {
      console.log("token data", response.data);
      console.log("Onchain data", response.data[0].onChainData);
      return response.data[0]; // Return the metadata for the token
    } else {
      console.error('No metadata found for the given mint address.');
      return {};
    }

  } catch (error) {
    console.error('Error fetching token metadata from Helius API:', error.message);
    return {}; // Return empty object on failure
  }
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

  if (answer === 'buy_token') {

    // Ask the user for the token address
    const tokenMint = await input({
      message: 'Please enter the token address (mint):',
      validate(value) {
        const valid = value.length === 44 || value.length === 43;
        return valid || 'Please enter a valid Solana token address.';
      }
    });

    const mintAddress = new PublicKey(tokenMint);
    const tokenMetadata = await getTokenMetadata(tokenMint);
    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      mintAddress,
      wallet.publicKey
    );
    
    // Retrieve and display token info
    if (tokenAccount && tokenMetadata && mintAddress) {
      console.log(`Token Name: ${tokenMetadata.onChainData.data.name}`);
      console.log(`Symbol: ${tokenMetadata.onChainData.data.symbol}`);
      console.log(`Is Frozen: `, tokenAccount.isFrozen);
      console.log(`Mint Address: ${mintAddress.toBase58()}`);
    } else {
      console.error('Could not fetch token data.');
      await mainMenu(); // Return to menu if no metadata found
      return;
    }

    // Ask for the amount of SOL to spend for the token
    const transferAmount = await input({
      message: 'Please enter the amount of SOL to spend on the token:',
      validate(value) {
        const valid = !isNaN(value) && parseFloat(value) > 0;
        return valid || 'Please enter a valid amount of SOL.';
      }
    });

    // Initiate the swap (buy)
    await swapToken(tokenAccount, tokenMint, mintAddress, null, 'raydium', 'buy', true, parseFloat(transferAmount));
    await mainMenu(); // Re-run menu after buyin

  } else if (answer === 'sell_token') {
    // Ask the user for the token address
    const tokenMint = await input({
      message: 'Please enter the token address (mint):',
      validate(value) {
        const valid = value.length === 44 || value.length === 43;
        return valid || 'Please enter a valid Solana token address.';
      }
    });

    // Retrieve and display token info
    const tokenMetadata = await getTokenMetadata(tokenMint);
    const mintAddress = new PublicKey(tokenMint);
    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      mintAddress,
      wallet.publicKey
    );
  
    if (tokenMetadata && tokenAccount && mintAddress) {
      console.log(`Token Name: ${tokenMetadata.onChainData.data.name}`);
      console.log(`Symbol: ${tokenMetadata.onChainData.data.symbol}`);
      console.log(`Is Frozen: `, tokenAccount.isFrozen);
      console.log(`Mint Address: ${mintAddress.toBase58()}`);
    } else {
      console.error('Could not fetch token data.');
      await mainMenu(); // Return to menu if no metadata found
      return;
    }

    // Ask for the amount of tokens to sell
    const transferAmount = await input({
      message: 'Please enter the number of tokens to sell:',
      validate(value) {
        const valid = !isNaN(value) && parseFloat(value) > 0;
        return valid || 'Please enter a valid number of tokens.';
      }
    });

    // Initiate the swap (sell)
    await swapToken(tokenAccount, tokenMint, null, 'raydium', 'sell', true, parseFloat(transferAmount));
    await mainMenu(); // Re-run menu after selling

  } else if (answer === 'start_sniper') {
    await startSniper(); // Start the sniper process

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
  tokenAccount,
  tokenMint,
  mintAddress,
  poolAddress = null,
  exchange = 'raydium',
  direction = 'sell',
  USE_JITO = false,
  transferAmount = 0.0
) {

  console.log("starting swap");

  let poolKeys;
  if (exchange === 'raydium' && !poolAddress) {

    const response = await axios.get('https://api.raydium.io/v2/sdk/liquidity/mainnet.json');
    const allPools = response.data;
    const officialPools = allPools.official;
    const unofficialPools = allPools.unOfficial;

    writeJsonToFile(officialPools, 'officialPools.json');
    writeLargeJsonToFile(unofficialPools, 'unofficialPools.json');
    console.log("Official Pools count", officialPools.length);
    console.log("Unofficial Pools count", unofficialPools.length);

    let targetPool = officialPools.find(pool =>
      new PublicKey(pool.baseMint).equals(mintAddress) || 
      new PublicKey(pool.quoteMint).equals(mintAddress)
    );

    if (!targetPool) {
      targetPool = unofficialPools.find(pool =>
        new PublicKey(pool.baseMint).equals(mintAddress) || 
        new PublicKey(pool.quoteMint).equals(mintAddress)
      );
    }

    if (targetPool) {
      console.log("Target pool found:", targetPool);
    } else {
      console.log("No pool found.");
    }

  }

  console.log('Pool Keys Found:', poolKeys.id.toBase58());

  // Fetch pool info
  const poolInfo = await Liquidity.fetchInfo({
    connection,
    poolKeys,
    programId: LIQUIDITY_PROGRAM_ID_V4,
    layout: LIQUIDITY_STATE_LAYOUT_V4,
  });

  let inputAccount, outputAccount, amountIn, decimals, fixedSide, wrappedSolAccount;
  const preInstructions = [];
  const postInstructions = [];
  const signers = [];

  if (direction === 'buy' && !tokenBought) {
    // Swapping SOL for Token
    wrappedSolAccount = Keypair.generate();
    signers.push(wrappedSolAccount);

    // Create WSOL account
    const rentExemptLamports = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
    const lamportsForWSOL = transferAmount * LAMPORTS_PER_SOL + rentExemptLamports;

    preInstructions.push(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: wrappedSolAccount.publicKey,
        lamports: lamportsForWSOL,
        space: ACCOUNT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccountInstruction(
        wrappedSolAccount.publicKey,
        WSOL_MINT,
        wallet.publicKey
      )
    );

    // Close WSOL account after swap
    postInstructions.push(
      createCloseAccountInstruction(
        wrappedSolAccount.publicKey,
        wallet.publicKey,
        wallet.publicKey
      )
    );

    inputAccount = wrappedSolAccount.publicKey;
    outputAccount = tokenAccount.address;
    decimals = 9; // SOL has 9 decimals
    const amountInLamports = transferAmount * LAMPORTS_PER_SOL;
    amountIn = new TokenAmount(new BN(amountInLamports), decimals);
    fixedSide = 'in';

  } else if (direction === 'sell') {
    // Swapping Token for SOL
    wrappedSolAccount = Keypair.generate();
    signers.push(wrappedSolAccount);

    // Create temporary WSOL account to receive SOL
    const rentExemptLamports = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
    preInstructions.push(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: wrappedSolAccount.publicKey,
        lamports: rentExemptLamports,
        space: ACCOUNT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccountInstruction(
        wrappedSolAccount.publicKey,
        WSOL_MINT,
        wallet.publicKey
      )
    );

    // Close WSOL account after swap (unwrap SOL)
    postInstructions.push(
      createCloseAccountInstruction(
        wrappedSolAccount.publicKey,
        wallet.publicKey,
        wallet.publicKey
      )
    );

    inputAccount = tokenAccount.address;
    outputAccount = wrappedSolAccount.publicKey;

    // Get token decimals
    const mintInfo = await connection.getParsedAccountInfo(mintAddress);
    decimals = mintInfo.value.data.parsed.info.decimals;

    // Convert transfer amount to smallest units
    const amountInUnits = transferAmount * Math.pow(10, decimals);
    amountIn = new TokenAmount(new BN(amountInUnits), decimals);
    fixedSide = 'in';

    // Check if you have enough tokens
    const tokenBalance = await connection.getTokenAccountBalance(inputAccount);
    const balance = parseFloat(tokenBalance.value.amount);

    if (balance < amountInUnits) {
      console.error('Insufficient token balance to sell');
      return;
    }
  }

  // Set slippage tolerance (e.g., 1%)
  const slippage = new Percent(1, 100);

  // Create swap instruction
  const { instructions: swapInstructions, signers: swapSigners } = await Liquidity.makeSwapInstruction({
    connection,
    poolKeys,
    userKeys: {
      tokenAccounts: {
        input: inputAccount,
        output: outputAccount,
      },
      owner: wallet.publicKey,
      wrappedSolAccount: wrappedSolAccount ? wrappedSolAccount.publicKey : undefined,
    },
    amountIn,
    fixedSide,
    slippage,
  });
  
  console.log('Pre-instructions:', preInstructions);
  console.log('Swap instructions:', swapInstructions);
  console.log('Post-instructions:', postInstructions);
  console.log('Signers:', signers);
  // Combine all instructions and signers
  const transaction = new Transaction();
  transaction.add(...preInstructions, ...swapInstructions, ...postInstructions);

  transaction.feePayer = wallet.publicKey;

  signers.push(...swapSigners);

  if (USE_JITO) {
    addTipInstruction(transaction);
  }

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.sign(...[wallet, ...signers]);

  if (USE_JITO) {

    const serializedTransaction = transaction.serialize();
    const base64EncodedTransaction = serializedTransaction.toString('base64');
    await sendBundleToJito([base64EncodedTransaction]);

  } else {

    try {
      const txid = await sendAndConfirmTransaction(
        connection,
        transaction,
        [wallet, ...signers],
        { commitment: 'confirmed' }
      );
      console.log(
        `${direction.charAt(0).toUpperCase() + direction.slice(1)} transaction sent:`,
        txid
      );
    } catch (error) {
      console.error(`Error sending ${direction} transaction:`, error);
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

          /*console.log(data);*/
          const tokenTransfers = data.tokenTransfers;
          const accountData = data.accountData;
          let newTokenMint = tokenTransfers[0].mint;

          if (newTokenMint == "So11111111111111111111111111111111111111112") {
            newTokenMint = tokenTransfers[1].mint;
          }
          
          const targetBalanceChange = 6124800;
          const poolID = accountData.find(item => item.nativeBalanceChange === targetBalanceChange)?.account;

          if (poolID) {
            console.log("New token mint: ", newTokenMint);
            console.log("Pool ID: ", poolID);
            poolKeys = await Liquidity.getAssociatedPoolKeys({
              poolId: new PublicKey(poolID),
              programId: new PublicKey(LIQUIDITY_PROGRAM_ID_V4),
            });

            console.log('Pool Keys Found:', poolKeys.id.toBase58());
          }
  
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

