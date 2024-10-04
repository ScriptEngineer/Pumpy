import fs, { read } from 'fs';
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
dotenv.config(); // Load environment variables

const PORT = process.env.PORT || 3000;
const JITO_ENDPOINT = 'https://bundle-api.mainnet.jito.network'; // Updated to the correct Jito endpoint
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Base58 encoded
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

if (!PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY is not set in environment variables');
}

const secretKey = bs58.decode(PRIVATE_KEY);
const wallet = Keypair.fromSecretKey(secretKey);
const connection = new Connection(RPC_URL!, 'confirmed');
const RAYDIUM_AMM_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const LIQUIDITY_PROGRAM_ID_V4 = new PublicKey('5quB2RnXqpVpDwFETegxYGrvp3pCHNRtT5Rt6r5wNKS');
const RAYDIUM_SWAP_PROGRAM = '5quB2RnXqpVpDwFETegxYGrvp3pCHNRtT5Rt6r5wNKS';
let tokenBought = false;

async function getTokenMetadata(mintAddress: string): Promise<any> {
  const heliusUrl = `https://api.helius.xyz/v0/tokens/metadata?api-key=${process.env.HELIUS_API_KEY}`; // API URL with your Helius API key

  try {
    // Prepare the request payload
    const data = {
      mintAccounts: [mintAddress],
    };

    // Make the API call to Helius
    const response = await axios.post(heliusUrl, data, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    });

    // Check if the response contains data
    if (response.data && response.data.length > 0) {
      console.log('token data', response.data);
      console.log('Onchain data', response.data[0].onChainData);
      return response.data[0]; // Return the metadata for the token
    } else {
      console.error('No metadata found for the given mint address.');
      return {};
    }
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
    // Use the first existing WSOL account
    return wsolAccounts.value[0].pubkey;
  } else {
    // Create and fund a new WSOL account in a separate transaction
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
        value: 'exit',
      },
      new Separator(),
    ],
  });

  if (answer === 'buy_token') {
    // Ask the user for the token address
    const tokenMint = await input({
      message: 'Please enter the token address (mint):',
      validate(value: string) {
        const valid = value.length === 44 || value.length === 43;
        return valid || 'Please enter a valid Solana token address.';
      },
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
      validate(value: string) {
        const valid = !isNaN(Number(value)) && parseFloat(value) > 0;
        return valid || 'Please enter a valid amount of SOL.';
      },
    });

    // Initiate the swap (buy)
    await mainMenu(); // Re-run menu after buying
  } else if (answer === 'sell_token') {
    // Ask the user for the token address
    const tokenMint = await input({
      message: 'Please enter the token address (mint):',
      validate(value: string) {
        const valid = value.length === 44 || value.length === 43;
        return valid || 'Please enter a valid Solana token address.';
      },
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
      validate(value: string) {
        const valid = !isNaN(Number(value)) && parseFloat(value) > 0;
        return valid || 'Please enter a valid number of tokens.';
      },
    });

    // Initiate the swap (sell)
    await mainMenu(); // Re-run menu after selling
  } else if (answer === 'start_sniper') {
    await startSniper(); // Start the sniper process
  } else if (answer === 'token_metadata') {
    const tokenMint = await input({
      message: 'Please enter the token address (mint) to fetch metadata:',
      validate(value: string) {
        const valid = value.length === 44 || value.length === 43;
        return valid || 'Please enter a valid Solana token address.';
      },
    });

    const metadata = await getTokenMetadata(tokenMint);
    console.log(metadata);

    await mainMenu(); // Re-run menu after metadata fetch
  } else if (answer === 'exit') {
    console.log('Exiting...');
    process.exit(0);
  }
}

function isValidPublicKeyData(data: any): boolean {
  return data instanceof PublicKey && data.toBase58() !== '11111111111111111111111111111111';
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
  amountInLamports: number
): Promise<void> {
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


async function sendBundleToJito(bundledTxns: VersionedTransaction[]) {
	try {
    /*
		const bundleId = await searcherClient.sendBundle(new JitoBundle(bundledTxns, bundledTxns.length));
		console.log(`Bundle ${bundleId} sent.`);

		const result = await new Promise((resolve, reject) => {
			searcherClient.onBundleResult(
				(result) => {
					console.log("Received bundle result:", result);
					resolve(result); 
				},
				(e: Error) => {
					console.error("Error receiving bundle result:", e);
					reject(e); 
				}
			);
		});

		console.log("Result:", result);
    */

	} catch (error) {
		const err = error as any;
		console.error("Error sending bundle:", err.message);

		if (err?.message?.includes("Bundle Dropped, no connected leader up soon")) {
			console.error("Error sending bundle: Bundle Dropped, no connected leader up soon.");
		} else {
			console.error("An unexpected error occurred:", err.message);
		}
	}
}

async function sendVersionedTransaction(tx: VersionedTransaction) {
  const txid = await connection.sendTransaction(tx, {
    skipPreflight: true,
  })

  return txid
}

function addTipInstruction(transaction: Transaction): void {
  const tipAccount = new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'); // Random tip account
  const tipAmountLamports = 1000; // Minimum required tip (adjust as needed)

  const tipInstruction = SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: tipAccount,
    lamports: tipAmountLamports,
  });

  transaction.add(tipInstruction);
}

async function startSniper(): Promise<void> {
  try {
    let readyForNext = true;
    console.log('');
    const app = express();
    app.use(bodyParserJson());

    app.listen(PORT, async () => {
      console.log(`Firing up on port ${PORT}...`);
    });

    app.post('/', async (req: express.Request, res: express.Response) => {
      console.log('TESTER TESTING');
      res.status(200).send('Received');
    });

    app.post('/ray', async (req: express.Request, res: express.Response) => {
      try {
        
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

          console.log('Pool ID:', poolID);
          console.log('New Token Mint:', newTokenMint);

          const tokenKey = new PublicKey(newTokenMint);
          const poolPubKey = new PublicKey(poolID);
          const poolAccountInfo = await connection.getAccountInfo(poolPubKey);
          const poolData = LIQUIDITY_STATE_LAYOUT_V4.decode(poolAccountInfo!.data);
          const marketAccount = await connection.getAccountInfo(poolData.marketId);
          const marketProgramId = marketAccount!.owner;
          const marketState = MARKET_STATE_LAYOUT_V3.decode(marketAccount!.data);

          if (poolData && marketState) {

            console.log('Getting market authority...');

            const marketAuthority1 = Market.getAssociatedAuthority({
              programId: marketProgramId,
              marketId: marketState.ownAddress,
            }).publicKey;
          
            /*
            const marketAuthority1 = PublicKey.createProgramAddressSync(
              [
                marketState.ownAddress.toBuffer(),
                marketState.vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
              ],
              MAINNET_PROGRAM_ID.OPENBOOK_MARKET
            );
            */

            console.log('Getting associated authority...');

            const authority = Liquidity.getAssociatedAuthority({
              programId: new PublicKey(RAYDIUM_AMM_PROGRAM_ID),
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
              /*
              marketProgramId: MAINNET_PROGRAM_ID.OPENBOOK_MARKET,
              */
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
              /*
              marketProgramId: MAINNET_PROGRAM_ID.OPENBOOK_MARKET.toBase58(),
              */
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

              const poolInfo = await Liquidity.fetchInfo({ connection, poolKeys });

              console.log("Checking for low liquidity...");
              console.log('Pool Reserves:', {
                baseReserve: poolInfo.baseReserve.toString(),
                quoteReserve: poolInfo.quoteReserve.toString(),
              });

              if (poolInfo.baseReserve.isZero() || poolInfo.quoteReserve.isZero()) {
                console.error('Pool has insufficient liquidity for swapping.');
                readyForNext = true;
                return;
              }

              const transferAmount = 0.01; 
              const amountInLamports = transferAmount * LAMPORTS_PER_SOL;
              const priorityMicroLamports = 10000000; 
              const directionIn = poolKeys.quoteMint.toString() == newTokenMint

              console.log("Calculating amount out...");
              const { amountIn, amountOut, minAmountOut } = await calcAmountOut(
                poolKeys,
                transferAmount,
                10,
                directionIn
              );

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
              }

              const wsolAccountData = AccountLayout.decode(wsolAccountInfo.data);

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

              console.log('Combining instructions');
              const preInstructions: TransactionInstruction[] = [];
              const allInstructions: TransactionInstruction[] = [...preInstructions, ...instructions];
              const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

              console.log('Compiling and sending transaction message...');
              const messageV0 = new TransactionMessage({
                payerKey: wallet.publicKey,
                recentBlockhash: blockhash,
                instructions: allInstructions,
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
                readyForNext = true;
                tokenBought = false;
              } else if (confirmationResult) {
                console.log('Transaction confirmed.');
                tokenBought = true;
                readyForNext = true;
              }

            } else {
              readyForNext = true;
            }

          } else {
            readyForNext = true;
            console.error('poolAccountInfo is undefined.');
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

        const data = req.body[0];
        const tokenMint = data.tokenTransfers[0].mint;

        console.log(data);
        console.log('PUMP FUN POOL CREATED');
        console.log('Token Mint: ', tokenMint);

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

        console.log('Initial SOL Liquidity: ', initialSol);
        console.log('Initial Tokens Liquidity: ', initialTokens);

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
