import fs from 'fs';
import {
  ComputeBudgetProgram,
  Keypair,
  Connection,
  Transaction,
  PublicKey,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  SystemProgram,
} from '@solana/web3.js';

import {
  getOrCreateAssociatedTokenAccount,
  createInitializeAccountInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  ACCOUNT_SIZE,
} from '@solana/spl-token';

import {
  Liquidity,
  LIQUIDITY_POOLS,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolKeys,
  MAINNET_PROGRAM_ID,
  MARKET_STATE_LAYOUT_V3,
  TokenAccount,
  Token,
  TokenAmount,
  Percent,
  Market,
} from '@raydium-io/raydium-sdk';

import JSONStream from 'JSONStream';
import express from 'express';
import { json } from 'body-parser';
import axios from 'axios';
import bs58 from 'bs58';
import 'dotenv/config';
import BN from 'bn.js'; // BigNumber library for handling large integers

const PORT: number = parseInt(process.env.PORT || '3000');
const JITO_ENDPOINT: string = process.env.JITO_ENDPOINT || 'https://api.jito.wtf/';
const RPC_URL: string = process.env.RPC_URL || '';
const PRIVATE_KEY: string = process.env.PRIVATE_KEY || '';
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

if (!PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY is not set in environment variables');
}

const secretKey = bs58.decode(PRIVATE_KEY);
const wallet = Keypair.fromSecretKey(secretKey);
const connection = new Connection(RPC_URL, 'confirmed');
const RAYDIUM_AMM_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const LIQUIDITY_PROGRAM_ID_V4 = new PublicKey('5quB2RnXqpVpDwFETegxYGrvp3pCHNRtT5Rt6r5wNKS');
const RAYDIUM_SWAP_PROGRAM = '5quB2RnXqpVpDwFETegxYGrvp3pCHNRtT5Rt6r5wNKS';
let tokenBought = false;

async function getTokenMetadata(mintAddress: string): Promise<any> {
  const heliusUrl = `https://api.helius.xyz/v0/tokens/metadata?api-key=${process.env.HELIUS_API_KEY}`;

  try {
    const data = {
      mintAccounts: [mintAddress],
    };

    const response = await axios.post(heliusUrl, data, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    });

    if (response.data && response.data.length > 0) {
      console.log('token data', response.data);
      console.log('Onchain data', response.data[0].onChainData);
      return response.data[0];
    } else {
      console.error('No metadata found for the given mint address.');
      return {};
    }
  } catch (error) {
    console.error('Error fetching token metadata from Helius API:', error.message);
    return {};
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

  // Handle user selections...

  if (answer === 'buy_token') {
    // Logic for 'buy_token'
  }
  // Continue with other logic...
}

async function sendBundleToJito(transactions: string[]): Promise<void> {
  try {
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [transactions],
    };

    const response = await axios.post(JITO_ENDPOINT, payload, {
      headers: { 'Content-Type': 'application/json' },
    });

    console.log('Bundle submitted to Jito: ', response.data);
  } catch (error) {
    console.error('Error submitting bundle to Jito: ', error.message);
  }
}

function addTipInstruction(transaction: Transaction): void {
  const tipAccount = new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5');
  const tipAmountLamports = 1000;

  const tipInstruction = SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: tipAccount,
    lamports: tipAmountLamports,
  });

  transaction.add(tipInstruction);
}

async function startSniper(): Promise<void> {
  // Sniper logic...
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
