import fs, { read } from 'fs';
import { formatInTimeZone } from 'date-fns-tz';
import {
  ComputeBudgetProgram,
  Keypair,
  Connection,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  MessageV0,
  Signer,
  sendAndConfirmTransaction,
  VersionedTransaction,
} from '@solana/web3.js';

import {
  getOrCreateAssociatedTokenAccount,
  createInitializeAccountInstruction,
  createSyncNativeInstruction, 
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  ACCOUNT_SIZE,
  AccountLayout,
} from '@solana/spl-token';

import {
  Liquidity,
  LiquidityPoolKeys,
  LiquidityPoolJsonInfo,
  TokenAccount,
  Token,
  TokenAmount,
  Percent,
  SPL_ACCOUNT_LAYOUT,
  MAINNET_PROGRAM_ID,
  LIQUIDITY_STATE_LAYOUT_V4,
  MARKET_STATE_LAYOUT_V3,
  Market,
} from '@raydium-io/raydium-sdk';

/*import { Bundle as JitoBundle } from "jito-ts/dist/sdk/block-engine/types.js";*/
import { searcherClient } from "./src/jito";
import { getRandomTipAccount } from "./src/config";
import express from 'express';
import { json as bodyParserJson } from 'body-parser';
import axios from 'axios';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import BN from 'bn.js'; // BigNumber library for handling large integers
import BigNumber from 'bignumber.js';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import input from "input";

dotenv.config(); // Load environment variables

const PRIVATE_KEY = process.env.PRIVATE_KEY; 
if (!PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY is not set in environment variables');
}

const texasTimezone = 'America/Chicago';
const walletsPath = './wallets.json';
const PORT = process.env.PORT || 3000;
const JITO_ENDPOINT = 'https://bundle-api.mainnet.jito.network'; // Updated to the correct Jito endpoint
const RPC_URL = process.env.RPC_URL;
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const secretKey = bs58.decode(PRIVATE_KEY);
const wallet = Keypair.fromSecretKey(secretKey);
const connection = new Connection(RPC_URL!, 'confirmed');
const RAYDIUM_AMM_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_SWAP_PROGRAM = '5quB2RnXqpVpDwFETegxYGrvp3pCHNRtT5Rt6r5wNKS';
const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

let tokenBought = false;

async function getWalletAssets(targetAddress: string): Promise<any> {
  try {
    
    const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
      method: 'POST',
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "lookup-" + targetAddress,
        method: "getAssetsByOwner",
        params: {
          ownerAddress: targetAddress,
          page: 1, // Starts at 1
          limit: 1000,
          displayOptions: {
            showFungible: true //return both fungible and non-fungible tokens
          }
        },
      }),
    });

    const data = await response.json();
    return data;

  } catch (error: any) {
    console.error('Error fetching token metadata from Helius API:', error.message);
    return {}; // Return empty object on failure
  }
}

async function getTokenMetadata(mintAddress: string): Promise<any> {

  try {
    
    const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
      method: 'POST',
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        "jsonrpc": "2.0",
        "id": mintAddress,
        "method": "getAsset",
        "params": {
          "id": mintAddress,
          "displayOptions": {
            "showCollectionMetadata": true,
            "showFungible": true,
            "showInscription": true,
          }
        }
      }),
    });

    const data = await response.json();
    return data;

  } catch (error: any) {
    console.error('Error fetching token metadata from Helius API:', error.message);
    return {}; // Return empty object on failure
  }
}

async function getOrCreateWSOLAccount(amountInLamports: number): Promise<PublicKey> {
  const wsolAccounts = await connection.getTokenAccountsByOwner(wallet.publicKey, {
    mint: WSOL_MINT,
  });

  if (wsolAccounts.value.length > 0) {
    console.log("Existing WSOL account found...");
    return wsolAccounts.value[0].pubkey;
  } else {
    console.log("Funding new WSOL account...");
    const rentExemptLamports = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
    const lamportsForWSOL = amountInLamports + rentExemptLamports;
    const wrappedSolAccount = Keypair.generate();

    const createAccountInstruction = SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: wrappedSolAccount.publicKey,
      lamports: lamportsForWSOL,
      space: ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    });

    const initializeAccountInstruction = createInitializeAccountInstruction(
      wrappedSolAccount.publicKey,
      WSOL_MINT,
      wallet.publicKey
    );

    const transaction = new Transaction().add(createAccountInstruction, initializeAccountInstruction);
    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;

    // Sign and send the transaction
    await sendAndConfirmTransaction(connection, transaction, [wallet, wrappedSolAccount]);

    // Return the public key of the new WSOL account
    return wrappedSolAccount.publicKey;
  }
}

async function getOwnerTokenAccounts(): Promise<TokenAccount[]> {
  const walletTokenAccounts = await connection.getTokenAccountsByOwner(wallet.publicKey, {
    programId: TOKEN_PROGRAM_ID,
  });

  return walletTokenAccounts.value.map((i) => ({
    pubkey: i.pubkey,
    programId: i.account.owner,
    accountInfo: AccountLayout.decode(i.account.data),
  })) as TokenAccount[];
}

async function getAssetsByOwner(): Promise<any[]> {
  const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

  try {
    const response = await fetch(heliusUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'get-assets',
        method: 'getAssetsByOwner',
        params: {
          ownerAddress: wallet.publicKey.toBase58(),
          page: 1,
          limit: 1000,
          displayOptions: {
            showFungible: true, // Fetch fungible tokens (like SPL tokens)
            showNativeBalance: true, // Optionally show native SOL balance
          },
        },
      }),
    });

    const data: { result?: { items: any[] } } = await response.json();
    return data.result?.items || [];
  } catch (error: any) {
    console.error('Error fetching assets:', error.message);
    return [];
  }
}

async function getTokenBalances() {
  try {
    // Fetch all assets owned by the wallet
    const assets = await getAssetsByOwner();
    const fungibleTokens = assets.filter(asset => asset.interface === 'FungibleToken');

    return fungibleTokens;
    
  } catch (error: any) {
    console.error('Error fetching token balances:', error.message);
  }
}

async function mainMenu(): Promise<void> {
  const { select, input, Separator } = await import('@inquirer/prompts');

  const answer = await select({
    message: 'Main Menu',
    choices: [
      new Separator(),
      {
        name: 'Buy Token',
        value: 'buy_token',
        description: 'Buy a token from Raydium or Pump Fun',
      },{
        name: 'Sell Token',
        value: 'sell_token',
        description: 'Sell a token from Raydium or Pump Fun',
      },{
        name: 'Deposit WSOL',
        value: 'deposit_wsol',
        description: 'Deposit into WSOL account',
      },{
        name: 'Start Pumping',
        value: 'start_pumping',
        description: 'Start Pumping!',
      },{
        name: 'Start Sniper',
        value: 'start_sniper',
        description: 'Start Sniping a Specific Token',
      },{
        name: 'Start Tele Bot',
        value: 'start_telegram_bot',
        description: 'Start Telegram Bot',
      },{
        name: 'Get Token Metadata',
        value: 'token_metadata',
        description: 'Get token information',
      },{
        name: 'Get Token Balances',
        value: 'view_balances',
        description: 'See shitcoin balances in USDC',
      },{
        name: 'Get Warchest',
        value: 'get_warchest',
        description: 'View Warchest Info',
      },{
        name: 'Inspect Wallet',
        value: 'inspect_wallet',
        description: 'View Assets By Owner',
      },{
        name: 'Wrap SOL',
        value: 'wrap_sol',
        description: 'Convert SOL in Token Account into WSOL',
      },{
        name: 'Start Watcher',
        value: 'start_watcher',
        description: 'Listen for wallet activity',
      },{
        name: 'Sync Wallets',
        value: 'sync_wallets',
        description: 'Sync Wallet Assets',
      },{
        name: 'Exit',
        value: 'exit',
      },
      new Separator(),
    ],
  });

  if (answer === 'buy_token') {

    const tokenMint = await input({
      message: 'Please enter the token address (mint):',
      validate(value: string) {
        const valid = value.length === 44 || value.length === 43;
        return valid || 'Please enter a valid Solana token address.';
      },
    });

    const mintAddress = new PublicKey(tokenMint);
    const metadata : any = await getTokenMetadata(tokenMint);
    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      mintAddress,
      wallet.publicKey
    );

    if (tokenAccount && metadata && mintAddress) {
      console.log(metadata);
      console.log(`\nToken Symbol: ${metadata.result.token_info.symbol}`);
      console.log(`Token Supply: ${metadata.result.token_info.supply}`);
      console.log(`Token Decimals: ${metadata.result.token_info.decimals}`);
      console.log(`Token Price Per Token: ${metadata.result.token_info.price_info.price_per_token}`);
    }
   
    const transferAmount = await input({
      message: 'Please enter the amount of SOL to spend on the token:',
      validate(value: string) {
        const valid = !isNaN(Number(value)) && parseFloat(value) > 0;
        return valid || 'Please enter a valid amount of SOL.';
      },
    });

    const buySignature = await sendJitoPump(tokenMint, "buy", parseFloat(transferAmount), 15, 0.005, "true");
    await connection.confirmTransaction(buySignature, 'finalized');
    console.log(`Buy transaction ${buySignature} confirmed`);

    await mainMenu();

  } else if (answer === 'get_warchest') {

    await getWarchest();
    await mainMenu();

  } else if (answer === 'deposit_wsol') {
  
    console.log("Getting or creating the WSOL account...");

    const transferAmount = 0.1;
    const amountInLamports = transferAmount * LAMPORTS_PER_SOL;
    const wsolAccountPubkey = await getOrCreateWSOLAccount(amountInLamports);

    let depositAmount = await input({
      message: 'Please enter the amount of Sol to convert into WSOL:',
      validate(value: string) {
        const valid = !isNaN(Number(value)) && parseFloat(value) > 0;
        return valid || 'Please enter a valid number of tokens.';
      },
    });

    await depositToWSOLAccount(wsolAccountPubkey, parseFloat(depositAmount));

  } else if (answer === 'sell_token') {

    const tokenMint = await input({
      message: 'Please enter the token address (mint):',
      validate(value: string) {
        const valid = value.length === 44 || value.length === 43;
        return valid || 'Please enter a valid Solana token address.';
      },
    });

    const mintAddress = new PublicKey(tokenMint);
    const metadata : any = await getTokenMetadata(tokenMint);
    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      mintAddress,
      wallet.publicKey
    );

    if (tokenAccount && metadata && mintAddress) {
      console.log(metadata);
      console.log(`\nToken Symbol: ${metadata.result.token_info.symbol}`);
      console.log(`Token Supply: ${metadata.result.token_info.supply}`);
      console.log(`Token Decimals: ${metadata.result.token_info.decimals}`);
      console.log(`Token Price Per Token: ${metadata.result.token_info.price_info.price_per_token}`);
    }

    const sellSignature = await sendJitoPump(tokenMint, "sell", "100%", 15, 0.005, "true");
    await connection.confirmTransaction(sellSignature, 'finalized');
    console.log(`Sell transaction ${sellSignature} confirmed`);
    await mainMenu();

  } else if (answer === 'start_pumping') {
    await startListener(); // Start the sniper process
  } else if (answer === 'start_sniper') {
    const tokenMint = await input({
      message: 'Please enter the token address (mint) to snipe:',
      validate(value: string) {
        const valid = value.length === 44 || value.length === 43;
        return valid || 'Please enter a valid Solana token address.';
      },
    });

    await snipe(tokenMint, 0.1, 15, 25, 0.005, 0.01, 5000, "true");
    await mainMenu(); // Re-run menu after metadata fetch

  } else if (answer === 'token_metadata') {
    const tokenMint = await input({
      message: 'Please enter the token address (mint) to fetch metadata:',
      validate(value: string) {
        const valid = value.length === 44 || value.length === 43;
        return valid || 'Please enter a valid Solana token address.';
      },
    });

    const metadata : any = await getTokenMetadata(tokenMint);

    console.log(metadata);
    console.log(`\nToken Symbol: ${metadata.result.token_info.symbol}`);
    console.log(`Token Supply: ${metadata.result.token_info.supply}`);
    console.log(`Token Decimals: ${metadata.result.token_info.decimals}`);
    console.log(`Token Price Per Token: ${metadata.result.token_info.price_info.price_per_token}`);

    await mainMenu(); // Re-run menu after metadata fetch
  } else if (answer === 'view_balances') {

    const shitcoins = await getTokenBalances(); 
    shitcoins.forEach((tkn: any) => { 
      if (tkn.token_info.price_info) {
        console.log(`\n ${tkn.id}`);
        console.log(`${tkn.token_info.symbol} Balance: ${tkn.token_info.price_info.total_price.toFixed(2)} USD`);
      }
    });

    console.log(`\n`);
    
    if (shitcoins.length === 0) {
      console.log("No assets found.");
    }

    await mainMenu(); // Re-run the menu after displaying balances

  } else if (answer === 'wrap_sol') {
    const transferAmount = 0.1;
    const amountInLamports = transferAmount * LAMPORTS_PER_SOL;
    const wsolAccountPubkey = await getOrCreateWSOLAccount(amountInLamports);
    await syncWSOLAccount(wsolAccountPubkey);
    await mainMenu();
  } else if (answer === 'start_watcher') {

    await walletWatcher(); 
    
  } else if (answer === 'start_telegram_bot') {

    await telegramBot(); 
    
  } else if (answer === 'sync_wallets') {

    await syncWallets();
    await mainMenu();

  } else if (answer === 'inspect_wallet') {

    const targetAddress = await input({
      message: 'Please enter address to inspect:'
    });

    const assets = await getWalletAssets(targetAddress);

    if (assets.result && assets.result.items.length > 0) {
      const walletData = `
      -------------------------------
      Total Assets: ${assets.result.total}
      -------------------------------\n\n`;

      assets.result.items.forEach(ass => {
        console.log(`\n Symbol: ${ass.content.metadata.symbol} \n ${ass.id}`);
      });

    } else {
      console.log("No assets found.");
    }

    await mainMenu();

  } else if (answer === 'exit') {
    console.log('Exiting...');
    process.exit(0);
  }
}

async function calcAmountOut(
  poolKeys: LiquidityPoolKeys,
  rawAmountIn: number,
  slippage: number = 5,
  swapInDirection: boolean
) {

  const poolInfo = await Liquidity.fetchInfo({ connection, poolKeys });
  console.log("Got pool info to calculate amount out...");

  let currencyInMint = poolKeys.baseMint;
  let currencyInDecimals = poolInfo.baseDecimals;
  let currencyOutMint = poolKeys.quoteMint;
  let currencyOutDecimals = poolInfo.quoteDecimals;

  if (!swapInDirection) {
    currencyInMint = poolKeys.quoteMint;
    currencyInDecimals = poolInfo.quoteDecimals;
    currencyOutMint = poolKeys.baseMint;
    currencyOutDecimals = poolInfo.baseDecimals;
  }

  const currencyIn = new Token(TOKEN_PROGRAM_ID, currencyInMint, currencyInDecimals);
  const amountIn = new TokenAmount(currencyIn, rawAmountIn.toFixed(currencyInDecimals), false);
  const currencyOut = new Token(TOKEN_PROGRAM_ID, currencyOutMint, currencyOutDecimals);
  const slippageX = new Percent(slippage, 100); 

  const { amountOut, minAmountOut, currentPrice, executionPrice, priceImpact, fee } = Liquidity.computeAmountOut({
    poolKeys,
    poolInfo,
    amountIn,
    currencyOut,
    slippage: slippageX,
  });

  return {
    amountIn,
    amountOut,
    minAmountOut,
    currentPrice,
    executionPrice,
    priceImpact,
    fee,
  }
}

async function depositToWSOLAccount(
  wsolAccountPubkey: PublicKey,
  amountInSol: number // Amount in SOL
): Promise<void> {

  const amountInLamports = amountInSol * LAMPORTS_PER_SOL;
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: wsolAccountPubkey,
      lamports: amountInLamports,
    })
  );

  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;

  await sendAndConfirmTransaction(connection, transaction, [wallet]);
  console.log('Deposited SOL into WSOL account:', wsolAccountPubkey.toBase58());

}

async function syncWSOLAccount(wsolAccountPubkey: PublicKey): Promise<void> {
  
  const transaction = new Transaction().add(
    createSyncNativeInstruction(wsolAccountPubkey)
  );

  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;

  await sendAndConfirmTransaction(connection, transaction, [wallet]);
  console.log('Synced WSOL account to wrap native SOL into WSOL:', wsolAccountPubkey.toBase58());

}

async function getWarchest() {
  try {

    // Define the request details
    const apiUrl = 'https://api-bot-v1.dbotx.com/account/wallets?type=solana';
    const response = await axios.get(apiUrl, {
      headers: {
        'X-API-KEY': process.env.DBOT_API,
        'Content-Type': 'application/json'
      }
    });
    console.log(response.data.res);

  } catch (error: any) {
    console.error('Error setting up sniper:', error.message);
  }

}

async function botSwap({
  tokenAddress,
  chain = 'solana',
  type = 'sell',
  simulate = false,
}) {
  try {
  
    let apiUrl = 'https://api-bot-v1.dbotx.com/automation/swap_order';
    // Define the request details
    if (simulate) {
      apiUrl = "https://api-bot-v1.dbotx.com/simulator/sim_swap_order";
    }

    const sniperData = {
      chain: chain,
      pair: tokenAddress,
      walletId: "lztuv37x1q21uo",
      type: type,
      amountOrPercent: 0.05,
      stopEarnPercent: 0.4,
      stopLossPercent: 0.4,
      stopEarnGroup: [
        { 
          pricePercent: 0.2, 
          amountPercent: 0.5 
        },{ 
          pricePercent: 0.8, 
          amountPercent: 1 
        }
      ], 
      stopLossGroup: [ 
        { 
          pricePercent: 0.4, 
          amountPercent: 1 
        }
      ],
      priorityFee: "", 
    	gasFeeDelta: 5, 
      maxFeePerGas: 100, 
      jitoEnabled: true, 
      jitoTip: 0.01, 
      maxSlippage: 0.2, 
      concurrentNodes: 3, 
      retries: 10
    };

    const response = await axios.post(apiUrl, sniperData, {
      headers: {
        'X-API-KEY': process.env.DBOT_API,
        'Content-Type': 'application/json'
      }
    });

    console.log('Swap successful:', response.data);
    return response.data;

  } catch (error: any) {
    console.error('Error setting up sniper:', error.message);
  }

}

async function setupSniper({
  tokenAddress,
  chain = 'solana',
}) {
  try {
  
    // Define the request details
    const apiUrl = 'https://api-bot-v1.dbotx.com/automation/snipe_order';
    const sniperData = {
      enabled: true,
      chain: chain,
      token: tokenAddress,
      walletId: "lztuv37x1q21uo",
      expireDelta: 1800000, // 30 min task expiration time (in milliseconds) 
      buySettings: {
        buyAmountUI: 0.1,
        priorityFee: 0.00005,
        gasFeeDelta: 5,
        maxFeePerGas: 100,
        jitoEnabled: true,
        jitoTip: 0.001,
        maxSlippage: 0.1,
        minLiquidity: 10000,
        concurrentNodes: 3,
        retries: 1
      },
      sellSettings: {
        enabled: true,
        stopEarnEnabled: true,
        stopEarnMode: "profit_percent",
        stopEarnPercentOrPrice: 1,
        stopLossEnabled: true,
        stopLossMode: "loss_percent",
        stopLossPercentOrPrice: 0.5,
        autoSell: true,
        priorityFee: "0.00005",
        gasFeeDelta: 5,
        maxFeePerGas: 100,
        jitoEnabled: true,
        jitoTip: 0.001,
        maxSlippage: 0.2,
        concurrentNodes: 3,
        retries: 5
      }
    };

    const response = await axios.post(apiUrl, sniperData, {
      headers: {
        'X-API-KEY': process.env.DBOT_API,
        'Content-Type': 'application/json'
      }
    });


    console.log('Sniper created successfully:', response.data);
    return response.data;

  } catch (error: any) {
    console.error('Error setting up sniper:', error.message);
  }

}

async function swapToken({
  newTokenMint,
  poolKeys,
  transferAmount,
  slippage = 10,
  userTokenAccounts,
  priorityMicroLamports = 10000000,
}) {
  try {
    // Convert transferAmount to lamports if buying with SOL, otherwise use transferAmount directly for token quantity
    console.log("Calculating amount out...");

    const directionIn = poolKeys.quoteMint.toString() == newTokenMint;
    const { minAmountOut, amountIn, amountOut } = await calcAmountOut(poolKeys, transferAmount, slippage, directionIn)

    console.log('Swap Details:');
    console.log('Direction In:', directionIn ? 'Buying Token with WSOL' : 'Selling Token for WSOL');
    console.log('Amount In:', amountIn.toExact());
    console.log('Amount Out:', amountOut.toExact());
    console.log('Min Amount Out:', minAmountOut.toExact());
    console.log('Currency In Mint:', amountIn.token.mint.toBase58());

    console.log("Preparing the swap transaction...");
    const swapTransaction = await Liquidity.makeSwapInstructionSimple({
      makeTxVersion: 0,
      connection,
      poolKeys,
      userKeys: {
        tokenAccounts: userTokenAccounts,
        owner: wallet.publicKey,
      },
      amountIn: amountIn,
      amountOut: minAmountOut,
      fixedSide: 'in',
      config: {
        bypassAssociatedCheck: false,
      },
      computeBudgetConfig: {
        microLamports: priorityMicroLamports,
      },
    });

    const instructions = swapTransaction.innerTransactions[0].instructions.filter(Boolean);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

    console.log('Compiling and sending transaction message...');
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet]);

    const serializedTransaction = transaction.serialize();

    const txid = await connection.sendRawTransaction(serializedTransaction, {
      skipPreflight: false,
    });
    console.log('Transaction sent with txid:', txid);

    const confirmationResult = await connection.confirmTransaction(
      {
        signature: txid,
        blockhash: blockhash,
        lastValidBlockHeight: lastValidBlockHeight,
      },
      'confirmed'
    );

    if (confirmationResult.value.err) {
      console.error('Transaction failed:', confirmationResult.value.err);
      return "FAILED";
    } else if(confirmationResult) {
      console.log('Transaction confirmed!');
      return "SUCCESS";
    } else {
      return "FAILED";
    }

  } catch (error) {
    console.error('Error executing swap:', error);
    return "FAILED"
  }
}

async function syncWallets(): Promise<void> {
  try {

    const data = fs.readFileSync(walletsPath, 'utf8');
    const wallies = JSON.parse(data).treasure.wallets;

    for (const wally of wallies) {  
      const wallet = wally.id;
      const walletAssets = await getWalletAssets(wallet);
      console.log("Syncing wallet:", wallet);
    
      if (walletAssets.result && walletAssets.result.items.length > 0) {
        walletAssets.result.items.forEach(ass => {

          if (wally.tokens.length > 0 && ass.interface == 'FungibleToken') {
            wally.tokens.push(ass.id);
          } else if (ass.interface == 'FungibleToken') {
            wally.tokens = [ass.id]
          }

        });
      } else {
        console.log("No assets found.");
      }

    };

    const updatedData = JSON.stringify({"treasure": {"wallets": wallies}}, null, 2); 
    fs.writeFileSync(walletsPath, updatedData, 'utf8');
    console.log('Wallets JSON file has been updated successfully.');

  } catch (error) {
      console.error('Error updating wallets.json:', error);
  }

}

async function waitForConfirmation(connection, signature, commitment = 'confirmed') {
  return new Promise((resolve, reject) => {
    const listenerId = connection.onSignature(
      signature,
      (result) => {
        connection.removeSignatureListener(listenerId);
        if (result.err) {
          reject(new Error(`Transaction ${signature} failed: ${result.err}`));
        } else {
          resolve(result);
        }
      },
      commitment
    );
  });
}

async function walletWatcher(): Promise<void> {
  try {

    const app = express();
    app.use(bodyParserJson());

    app.listen(PORT, async () => {
      console.log(`Listening for wallet activity...`);
    });

    app.post('/watcher', async (req: express.Request, res: express.Response) => {
      try {

        const walletsInfo = fs.readFileSync(walletsPath, 'utf8');
        const wallets = JSON.parse(walletsInfo).treasure.wallets;
        /*const data = req.body[0];*/
        const copyWally = "2NuTVvXdrDLDY1jkYVQZvPLxgquRx8BcFLivd6QZK9nn";
        const matchedWally = wallets.find(wally => wally.id === copyWally);
    
        console.log('WALLET ACTIVITY NOTICED!!!');

        if (matchedWally) {

          const searchSet = new Set(matchedWally.tokens);  
          let checkWally = await getWalletAssets(matchedWally.id);

          if (checkWally.result && checkWally.result.items.length > 0) {
            checkWally.result.items.forEach(ass => {

              if (!searchSet.has(ass.id) && ass.interface == 'FungibleToken') {
                console.log("NEW SHINY COIN!!");
                console.log(`\n Symbol: ${ass.content.metadata.symbol} \n`);
                console.log(ass.id);

                matchedWally.tokens.unshift(ass.id);
                const updatedData = JSON.stringify({"treasure": {"wallets": wallets}}, null, 2); 
                fs.writeFileSync(walletsPath, updatedData, 'utf8');
              
                snipe(ass.id, 0.05, 15, 15, 0.005, 0.008, 8000, "true");

              }

            });

          } else {
            console.log("No assets found.");
          }

        }

      } catch (error: any) {
        console.error('Error in wallet watcher:', error.message);
      }
    });


  } catch (error: any) {
    console.error('Error in wallet watcher:', error.message);
  }
}

async function sendJitoPump(
  mintAddress: string, 
  type: string= "sell",
  amount: number | string,
  slippage: number,
  priorityFee: number,
  inSol: string="false",
) {

  try {

    const signerKeyPairs = [wallet];
    const bundledTxArgs = [
      {
        publicKey: signerKeyPairs[0].publicKey.toBase58(),
        action: type,
        mint: mintAddress, 
        denominatedInSol: inSol,  
        amount: amount, 
        slippage: slippage, 
        priorityFee: priorityFee, 
        pool: "pump"
      }
    ];

    const response = await fetch(`https://pumpportal.fun/api/trade-local`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(bundledTxArgs)
    });

    if (response.status === 200) { 
        
      const transactions = await response.json();
      console.log(transactions);
      
      let encodedSignedTransactions = [];
      let signatures = [];

      for(let i = 0; i < bundledTxArgs.length; i++){ //decode and sign each tx
        const tx = VersionedTransaction.deserialize(new Uint8Array(bs58.decode(transactions[i])));
        tx.sign([signerKeyPairs[i]]);
        encodedSignedTransactions.push(bs58.encode(tx.serialize()));
        signatures.push(bs58.encode(tx.signatures[0]));
      }
    
  
      const jitoResponse = await fetch(`https://mainnet.block-engine.jito.wtf/api/v1/bundles`, {
          method: "POST",
          headers: {
              "Content-Type": "application/json"
          },
          body: JSON.stringify({
              "jsonrpc": "2.0",
              "id": 1,
              "method": "sendBundle",
              "params": [
                encodedSignedTransactions
              ]
          })
      });

      const jitoResult:any = await jitoResponse.json();

      if (!jitoResponse.ok || !jitoResult.result) {
        throw new Error(`Jito API error: ${jitoResult.error || jitoResponse.statusText}`);
      }

      return signatures[0];

      
    } else {
      throw new Error(`Pump Portal API error: ${response.statusText}`);
    }

  } catch(e) {
    throw new Error(`sendJitoPump error: ${e.message || e}`);
  }
}

async function snipe(  
  mintAddress: string, 
  amount: number,
  slippageBuy: number,
  slippageSell: number,
  priorityBuy: number,
  prioritySell: number,
  sellDelay: number,
  inSol: string="false",
  retryInterval: number = 1000
): Promise<void> {
  try {

    const buySignature = await sendJitoPump(mintAddress, "buy", amount, slippageBuy, priorityBuy, inSol);
    await waitForConfirmation(connection, buySignature, 'confirmed');
    /*
    await connection.confirmTransaction(buySignature, 'finalized');
    */
    console.log(`Buy transaction ${buySignature} confirmed`);

    setTimeout(async () => {

      let sold = false;
      while (!sold) {
        try {
          // Attempt to execute the sell operation
          const sellSignature = await sendJitoPump(mintAddress, "sell", "100%", slippageSell, prioritySell, inSol);
          /*
          await connection.confirmTransaction(sellSignature, 'finalized');
          */
          await waitForConfirmation(connection, sellSignature, 'confirmed');
          console.log(`Sell transaction ${sellSignature} confirmed`);
          console.log("Sell operation successful");
          sold = true; // Exit the loop if the sell is successful
        } catch (e) {
          console.error("Sell attempt failed:", e.message || e);
          // Wait for the retry interval before the next attempt
          await new Promise(resolve => setTimeout(resolve, retryInterval));
        }
      }

      const shitcoins = await getTokenBalances();
      const stillThere = shitcoins.find((tkn: any) => tkn.id === mintAddress);
      
      if (stillThere) {
        const sellSignature = await sendJitoPump(mintAddress, "sell", "100%", 50, prioritySell, inSol);
        await connection.confirmTransaction(sellSignature, 'finalized');
        console.log(`Sell transaction ${sellSignature} confirmed`);
        console.log("Sell operation successful");
      }

    }, sellDelay);

  } catch(e) {
    console.error(e);
  }
}

async function telegramBot(): Promise<void> {
  try {

    console.log("Starting Telegram Bot");
    const apiId = parseInt(process.env.TELEGRAM_API_ID);  // Your API ID as a number
    const apiHash = process.env.TELEGRAM_API_HASH;  // Your API Hash
    const stringSession = new StringSession('1AQAOMTQ5LjE1NC4xNzUuNTgBuwg6qmHltyP/pw3CUfO8UaXoFG/U4mnzVF7ciRm5N7U4IoVA2Agjz/zINU98EmBFXCWBjUg1mjaNK8yPkmxlAVuW0nhr8mtg0VqY+YZMff1l3usJEtZbs53OJV5EpFvaWGBy5JtBfJhZ+Ykf5x5srNxpCpvZDtfClbu7aVXj3CBZ4Za0eX3Tw0kZnA2mBNNCh6E0bG4mpJmru25u8EiWmTD3VzEP22R8RY5QX7eTawSf7NIKDW9Nl8m0A7Evms5ePr/dUnIUN0FaeTyeWdTh6T0zCPQhUMeUqKWfTNFmOjlH9llZ9ybSQBneMzueKZfiSYncVOT7Q69ocd8ysuxUQKg=');  // Empty string if you haven't saved a session yet

    (async () => {
      console.log("Loading interactive example...");
      const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
      });

      await client.start({
        phoneNumber: async () => await input.text("Please enter your number: "),
        password: async () => await input.text("Please enter your password: "),
        phoneCode: async () =>
          await input.text("Please enter the code you received: "),
        onError: (err) => console.log(err),
      });

      console.log("You should now be connected.");
      console.log(client.session.save()); // Save this string to avoid logging in again

      const targetUsernames = ['target_username1', 'target_username2'];  // Add the usernames you want to listen for
      const targetUserIds = [123456789, 987654321];  // Add specific user IDs if you know them

      // Event handler for new messages
      client.addEventHandler(async (update) => {
        if (update.message) {

          const messageWhole = update.message;
          const message = messageWhole.message.trim();

          // Extract the "🟢 BUY" part using regular expression
          const buyMatch = message.match(/🟢 BUY [^\n]+/);
          const buyText = buyMatch ? buyMatch[0] : "No '🟢 BUY' found";
      
          // Extract the last line (ignoring empty lines)
          const lines = message.split('\n').filter(line => line.trim() !== '');
          const lastLine = lines.length > 0 ? lines[lines.length - 1] : "No last line found";
      
          // Print or return the extracted parts
          if (buyMatch) {
            console.log("Nut bought something:");
            console.log(lastLine);

            botSwap({
              tokenAddress: lastLine,
              chain: 'solana',
              type: 'buy',
              simulate: false,
            })
            
          } else {
            console.log(message);
          }

        }
      });
      
    })();

  } catch(e) {
    console.error(e);
  }

}

async function startListener(): Promise<void> {
  try {

    let readyForNext = true;
    let tokenBought = false;
    const app = express();
    app.use(bodyParserJson());
 
    const transferAmount = 0.1;
    const amountInLamports = transferAmount * LAMPORTS_PER_SOL;
    
    /* ~0.01 */
    const priorityMicroLamports = 10000000;

    console.log("Getting or creating the WSOL account...");
    const wsolAccountPubkey = await getOrCreateWSOLAccount(amountInLamports);
    const wsolBalance = await connection.getTokenAccountBalance(wsolAccountPubkey);
    const currentBalanceLamports = parseInt(wsolBalance.value.amount);

    if (currentBalanceLamports < amountInLamports) {
      const amountToDeposit = amountInLamports - currentBalanceLamports;
      await depositToWSOLAccount(wsolAccountPubkey, amountToDeposit);
    }

    console.log("Fetching the WSOL account info...");
    const wsolAccountInfo = await connection.getAccountInfo(wsolAccountPubkey);

    if (!wsolAccountInfo) {
      throw new Error('Failed to fetch WSOL account info');
    } else {
      console.log('Using WSOL Account:', wsolAccountPubkey.toBase58());
    }

    const wsolAccountData = AccountLayout.decode(wsolAccountInfo.data);

    app.listen(PORT, async () => {
      console.log(`Firing up on port ${PORT}...`);
    });

    app.post('/ray', async (req: express.Request, res: express.Response) => {
      try {
        
        let badToken = false;
        let newToken = true;
        const data = req.body[0];

        if (data.source === 'RAYDIUM' && readyForNext) {

          readyForNext = false;
          console.log('RAYDIUM LIQUIDITY POOL CREATED');

          const tokenTransfers = data.tokenTransfers;
          const accountData = data.accountData;
          let newTokenMint = tokenTransfers[0]?.mint;

          // Adjust for SOL being the first token
          if (newTokenMint === 'So11111111111111111111111111111111111111112') {
            newTokenMint = tokenTransfers[1]?.mint;
          }

          const targetBalanceChange = 6124800;
          const poolID = accountData.find(
            (item: any) => item.nativeBalanceChange === targetBalanceChange
          )?.account;

          if (!poolID) {
            readyForNext = true;
            console.error('poolID is undefined.');
            res.status(500).send('Error');
            return;
          }

          const tokenInfo: any = await getTokenMetadata(newTokenMint);

          if (tokenInfo.result.ownership.frozen || tokenInfo.result.mutable) {
            badToken = true;
            readyForNext = true;
            console.log('Skipping bad token...');
            return;
          }

          const tokenKey = new PublicKey(newTokenMint);
          const poolPubKey = new PublicKey(poolID);
          const poolAccountInfo = await connection.getAccountInfo(poolPubKey);
          const poolData = LIQUIDITY_STATE_LAYOUT_V4.decode(poolAccountInfo!.data);
          const marketAccount = await connection.getAccountInfo(poolData.marketId);
          const marketProgramId = marketAccount!.owner;
          const marketState = MARKET_STATE_LAYOUT_V3.decode(marketAccount!.data);
          const authority = Liquidity.getAssociatedAuthority({
            programId: new PublicKey(RAYDIUM_AMM_PROGRAM_ID),
          }).publicKey;

          if (tokenInfo.result.token_info.price_info) {
            newToken = false;
          }

          if (poolData && marketState && !badToken) {

            console.log('Getting market authority...');
            const marketAuthority1 = Market.getAssociatedAuthority({
              programId: marketProgramId,
              marketId: marketState.ownAddress,
            }).publicKey;
          
            console.log('Building pool keys...');
            const poolKeys: LiquidityPoolKeys = {
              id: poolPubKey,
              baseMint: tokenKey,
              quoteMint: new PublicKey('So11111111111111111111111111111111111111112'),
              lpMint: poolData.lpMint,
              baseDecimals: Number.parseInt(poolData.baseDecimal.toString()),
              quoteDecimals: Number.parseInt(poolData.quoteDecimal.toString()),
              lpDecimals: Number.parseInt(poolData.baseDecimal.toString()),
              version: 4,
              programId: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
              authority: authority,
              openOrders: poolData.openOrders,
              targetOrders: poolData.targetOrders,
              baseVault: poolData.baseVault,
              quoteVault: poolData.quoteVault,
              withdrawQueue: poolData.withdrawQueue,
              lpVault: poolData.lpVault,
              marketVersion: 3,
              marketProgramId: marketProgramId,
              marketId: poolData.marketId,
              marketAuthority: marketAuthority1,
              marketBaseVault: marketState.baseVault,
              marketQuoteVault: marketState.quoteVault,
              marketBids: marketState.bids,
              marketAsks: marketState.asks,
              marketEventQueue: marketState.eventQueue,
              lookupTableAccount: PublicKey.default,
            };

            console.log('Pool Keys RAW:', {
              id: poolID,
              baseMint: newTokenMint,
              quoteMint: 'So11111111111111111111111111111111111111112',
              lpMint: poolData.lpMint.toBase58(),
              baseDecimals: Number.parseInt(poolData.baseDecimal.toString()),
              quoteDecimals: Number.parseInt(poolData.quoteDecimal.toString()),
              lpDecimals: Number.parseInt(poolData.baseDecimal.toString()),
              version: 4,
              programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
              authority: authority.toBase58(),
              openOrders: poolData.openOrders.toBase58(),
              targetOrders: poolData.targetOrders.toBase58(),
              baseVault: poolData.baseVault.toBase58(),
              quoteVault: poolData.quoteVault.toBase58(),
              withdrawQueue: poolData.withdrawQueue.toBase58(),
              lpVault: poolData.lpVault.toBase58(),
              marketVersion: 3,
              marketProgramId: marketProgramId.toBase58(),
              marketId: poolData.marketId.toBase58(),
              marketAuthority: marketAuthority1.toBase58(),
              marketBaseVault: marketState.baseVault.toBase58(),
              marketQuoteVault: marketState.quoteVault.toBase58(),
              marketBids: marketState.bids.toBase58(),
              marketAsks: marketState.asks.toBase58(),
              marketEventQueue: marketState.eventQueue.toBase58(),
              lookupTableAccount: PublicKey.default.toBase58(),
            });

            if (!tokenBought && poolKeys) {

              const solInfo: any = await getTokenMetadata('So11111111111111111111111111111111111111112');
              const poolInfo = await Liquidity.fetchInfo({ connection, poolKeys });
              const solPrice = new BigNumber(solInfo.result.token_info.price_info.price_per_token);
              const quoteReserveBN = poolInfo.quoteReserve; 
              const quoteReserveDecimal = new BigNumber(quoteReserveBN.toString()).dividedBy(
                new BigNumber(10).pow(poolKeys.quoteDecimals)
              );
              const liquidityUSD = quoteReserveDecimal.multipliedBy(solPrice);
              const now = new Date();
              const timestamp = formatInTimeZone(now, texasTimezone, 'yyyy-MM-dd HH:mm:ss zzzz');
                      
              const tokenData = `
              -------------------------------
              Token Address: ${newTokenMint}
              Token Symbol: ${tokenInfo.result.token_info.symbol}
              Token Supply: ${tokenInfo.result.token_info.supply}
              Token Decimals: ${tokenInfo.result.token_info.decimals}
              Token Price Per Token: ${tokenInfo.result.token_info.price_info?.price_per_token || 'N/A'}
              Token Owner: ${tokenInfo.result.ownership.owner}
              Creators: ${tokenInfo.result.creators.join(', ')}
              Pool ID: ${poolID}
              Token Liquidity : ${liquidityUSD.toFixed(2)} USD
              Timestamp: ${timestamp}
              -------------------------------\n\n`;
    
              fs.writeFile('tokenInfo.txt', tokenData, { flag: 'a' }, (err) => {
                if (err) {
                  console.error('Error writing to file:', err);
                }
              });
    
              console.log(tokenData);
              /*
              console.log(`Token Price Per Token: ${tokenInfo.result.token_info.price_info.price_per_token}`);
              */

              if (poolInfo.baseReserve.isZero() || poolInfo.quoteReserve.isZero() || liquidityUSD.toNumber() < 10000) {
                console.error('Pool has insufficient liquidity for swapping.');
                readyForNext = true;
                return;
              }

              let sendIt = await botSwap({
                tokenAddress: newTokenMint,
                chain: 'solana',
                type: "buy",
                simulate: true
              });

              /*
              console.log("Calculating amount out...");

              console.log("Creating a TokenAccount object for the WSOL account...");
              const wsolTokenAccount: TokenAccount = {
                pubkey: wsolAccountPubkey,
                programId: TOKEN_PROGRAM_ID,
                accountInfo: {
                  mint: WSOL_MINT,
                  owner: wallet.publicKey,
                  amount: new BN(wsolAccountData.amount, 10, 'le'),
                  delegateOption: wsolAccountData.delegateOption,
                  delegate: wsolAccountData.delegateOption ? wsolAccountData.delegate : null,
                  state: wsolAccountData.state,
                  isNativeOption: wsolAccountData.isNativeOption,
                  isNative: wsolAccountData.isNativeOption
                    ? new BN(wsolAccountData.isNative, 10, 'le')
                    : null,
                  delegatedAmount: new BN(wsolAccountData.delegatedAmount, 10, 'le'),
                  closeAuthorityOption: wsolAccountData.closeAuthorityOption,
                  closeAuthority: wsolAccountData.closeAuthorityOption
                    ? wsolAccountData.closeAuthority
                    : null,
                },
              };

              // Fetch existing token accounts
              const userTokenAccounts = await getOwnerTokenAccounts();

              // Include the WSOL token account if it's not already included
              const wsolAccountExists = userTokenAccounts.some((account) =>
                account.pubkey.equals(wsolAccountPubkey)
              );

              if (!wsolAccountExists) {
                userTokenAccounts.push(wsolTokenAccount);
              }

              let swap = await swapToken({
                newTokenMint,
                poolKeys,
                transferAmount,
                slippage: 10, 
                userTokenAccounts, 
              });
              
              if (swap == "SUCCESS") {
                tokenBought = true;
              } else {
                tokenBought = false;
                readyForNext = true;
              }
              */

              readyForNext = true;

            } else {
              readyForNext = true;
            }

          } else {
            readyForNext = true;
          }

        }

        res.status(200).send('Received');
      } catch (error: any) {
        readyForNext = true;
        console.error('Error processing /ray webhook:', error.message);
        res.status(500).send('Error');
      }
    });

    app.post('/pumpkins', async (req: express.Request, res: express.Response) => {
      try {

        let initialSol = 0;
        let initialTokens = 0;
        let badToken = false;
        
        if (tokenBought) {
          return;
        }

        const data = req.body[0];
        const tokenMint = data.tokenTransfers[0].mint;
        const tokenInfo: any = await getTokenMetadata(tokenMint);
      
        if (tokenInfo.result.ownership.frozen || tokenInfo.result.mutable) {
          console.log('Skipping bad token...');
          badToken = true;
          return;
        }    

        data.nativeTransfers.forEach((transfer: any) => {
          if (transfer.amount > initialSol) {
            initialSol = transfer.amount / LAMPORTS_PER_SOL;
          }
        });
        
        data.tokenTransfers.forEach((transfer: any) => {
          if (transfer.tokenAmount > initialTokens) {
            initialTokens = transfer.tokenAmount;
          }
        });

        /* Inital SOL liquidity too low */
        if (initialSol < 0.05) {
          badToken = true;
          return;
        } else {
          tokenBought = true;
        }
        
        console.log('\n PUMP FUN POOL CREATED');
        console.log('Token Mint: ', tokenMint);
        console.log(`Token Name: ${tokenInfo.result.content.metadata.name}`);
        console.log(`Token Symbol: ${tokenInfo.result.content.metadata.symbol}`);
        console.log('Initial SOL Liquidity: ', initialSol);
        console.log('Initial Tokens Liquidity: ', initialTokens);
        console.log("Sniping....");

        await snipe(tokenMint, 0.05, 15, 25, 0.005, 0.008, 60000, "true");

        res.status(200).send('Received');

      } catch (error: any) {
        console.error('Error processing /pumpkins webhook:', error.message);
        res.status(500).send('Error');
      }

    });
  } catch (error: any) {
    console.error('Error starting sniper:', error.message);
  }
}

(async () => {
  try {
    console.log(`\nUsing RPC URL:\n${RPC_URL}`);
    console.log(`\nPumping with: \n${PRIVATE_KEY}\n\n`);
    await mainMenu();
  } catch (error: any) {
    console.error('Error:', error.message);
  }
})();
