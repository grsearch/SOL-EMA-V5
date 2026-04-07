// src/pumpAmm.js — 直接调用 Pump AMM 卖出，绕过 Jupiter
//
// 延迟对比：
//   Jupiter：触发 → API请求(200-500ms) → 广播 → 确认(400ms) = 600-900ms+
//   直接AMM：触发 → 本地构建(<5ms) → 广播 → 确认(400ms) = 400-500ms
//
// Pump AMM sell instruction 账户列表（最新版，含 fee_config / fee_program）：
//   0.  pool                    (writable)  — pool PDA
//   1.  global_config           (readonly)  — GlobalConfig PDA
//   2.  user                    (signer)    — 用户钱包
//   3.  base_mint               (readonly)  — token mint
//   4.  quote_mint              (readonly)  — WSOL mint
//   5.  user_base_token_account (writable)  — 用户 token ATA
//   6.  user_quote_token_account(writable)  — 用户 WSOL ATA
//   7.  pool_base_token_account (writable)  — pool token vault
//   8.  pool_quote_token_account(writable)  — pool SOL vault
//   9.  protocol_fee_recipient  (writable)  — 协议费收款方（取8个之一）
//   10. protocol_fee_recipient_token_account(writable) — 协议费 token ATA
//   11. token_program           (readonly)  — SPL Token program
//   12. token_program_2022      (readonly)  — Token-2022 program
//   13. system_program          (readonly)
//   14. associated_token_program(readonly)
//   15. coin_creator_vault      (writable)  — creator fee vault
//   16. coin_creator_vault_ata  (writable)  — creator fee token ATA
//   17. event_authority         (readonly)  — Pump AMM event authority PDA
//   18. program                 (readonly)  — Pump AMM program itself
//   19. fee_config              (readonly)  — Fee program config PDA（2025-09新增）
//   20. fee_program             (readonly)  — Fee program（2025-09新增）
//
// sell 指令参数（Borsh 编码）：
//   discriminator [8 bytes]: [51, 230, 133, 164, 1, 127, 131, 173]
//   base_amount_in  u64 LE  — 卖出 token 数量
//   min_quote_amount_out u64 LE — 最少收到 SOL（滑点保护）

'use strict';

const {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const logger = require('./logger');

// ── 程序地址常量 ──────────────────────────────────────────────
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const FEE_PROGRAM_ID      = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const TOKEN_PROGRAM_2022  = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOC_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const WSOL_MINT           = new PublicKey('So11111111111111111111111111111111111111112');

// sell discriminator（从 pump_amm IDL 提取）
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

// 协议费收款方列表（8个，从 Pump AMM 链上配置获取，取第0个）
const PROTOCOL_FEE_RECIPIENTS = [
  new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV'),
  new PublicKey('4nPVWCRHtb6E8Z3z3WDfmrpxJrMjzDkRXXbXLFdnaBTG'),
  new PublicKey('4xDsmETR7J2cmBEHFcJJpJNDtn4aMJFpNBfGMFvuOvxL'),
  new PublicKey('8eS3oH3CqQFRnKXRLQnZ3GNp7FkQBq7D6e9WyCc7Lg7B'),
];

// GlobalConfig PDA seeds: ["global_config"]
// EventAuthority PDA seeds: ["__event_authority"]
// FeeConfig PDA seeds: ["fee_config"]（在 FEE_PROGRAM）

// ── PDA 推导工具 ──────────────────────────────────────────────
function findGlobalConfigPda() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global_config')],
    PUMP_AMM_PROGRAM_ID
  )[0];
}

function findEventAuthorityPda() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    PUMP_AMM_PROGRAM_ID
  )[0];
}

function findFeeConfigPda() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config')],
    FEE_PROGRAM_ID
  )[0];
}

function findPoolPda(creatorPubkey, baseMintPubkey, index = 0) {
  // seeds: ["pool", index(u64 LE 8 bytes), creator, base_mint, quote_mint]
  const indexBuf = Buffer.alloc(8);
  indexBuf.writeBigUInt64LE(BigInt(index));
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('pool'),
      indexBuf,
      creatorPubkey.toBuffer(),
      baseMintPubkey.toBuffer(),
      WSOL_MINT.toBuffer(),
    ],
    PUMP_AMM_PROGRAM_ID
  )[0];
}

// ATA 地址推导（不需要创建，只计算地址）
function findAta(ownerPubkey, mintPubkey, tokenProgramId = TOKEN_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [
      ownerPubkey.toBuffer(),
      tokenProgramId.toBuffer(),
      mintPubkey.toBuffer(),
    ],
    ASSOC_TOKEN_PROGRAM
  )[0];
}

// ── 从链上 pool 账户读取数据 ──────────────────────────────────
// pool account layout（简化，只需要 creator、base/quote vault）：
//   [0..8]   discriminator
//   [8..16]  pool_bump (u8) + index (u64) = 9 bytes
//   [17..49] creator pubkey (32 bytes)
//   [49..81] base_mint (32 bytes)
//   [81..113] quote_mint (32 bytes)
//   [113..145] lp_mint (32 bytes)
//   [145..177] pool_base_token_account (32 bytes)
//   [177..209] pool_quote_token_account (32 bytes)
async function fetchPoolInfo(conn, poolPubkey) {
  const info = await conn.getAccountInfo(poolPubkey);
  if (!info) throw new Error(`Pool account not found: ${poolPubkey.toBase58()}`);
  const data = info.data;

  // 偏移量（Anchor 布局）
  const OFFSET_BUMP        = 8;       // 1 byte
  const OFFSET_INDEX       = 9;       // 8 bytes (u64)
  const OFFSET_CREATOR     = 17;      // 32 bytes
  const OFFSET_BASE_VAULT  = 145;     // 32 bytes
  const OFFSET_QUOTE_VAULT = 177;     // 32 bytes

  const creator         = new PublicKey(data.slice(OFFSET_CREATOR,    OFFSET_CREATOR + 32));
  const poolBaseVault   = new PublicKey(data.slice(OFFSET_BASE_VAULT,  OFFSET_BASE_VAULT + 32));
  const poolQuoteVault  = new PublicKey(data.slice(OFFSET_QUOTE_VAULT, OFFSET_QUOTE_VAULT + 32));

  return { creator, poolBaseVault, poolQuoteVault };
}

// ── 计算 min_quote_amount_out（含滑点）────────────────────────
// 从 pool vaults 当前余额估算卖出价格
async function calcMinQuoteOut(conn, poolBaseVault, poolQuoteVault, baseAmountIn, slippagePct = 0.5) {
  try {
    const [baseInfo, quoteInfo] = await Promise.all([
      conn.getTokenAccountBalance(poolBaseVault),
      conn.getTokenAccountBalance(poolQuoteVault),
    ]);
    const baseReserve  = BigInt(baseInfo.value.amount);
    const quoteReserve = BigInt(quoteInfo.value.amount);
    const amtIn        = BigInt(baseAmountIn);

    // constant product: quote_out = base_in * quote_reserve / (base_reserve + base_in)
    const quoteOut = (amtIn * quoteReserve) / (baseReserve + amtIn);

    // 扣除滑点容忍度（默认50%，RUG时接受任何价格）
    const minOut = quoteOut * BigInt(Math.floor((1 - slippagePct) * 1000)) / BigInt(1000);
    return minOut > 0n ? minOut : 0n;
  } catch (e) {
    logger.warn(`[PumpAmm] calcMinQuoteOut failed: ${e.message}, using 0`);
    return 0n;  // 0 = 接受任何价格（RUG时最安全）
  }
}

// ── 构建 sell 指令 ────────────────────────────────────────────
function buildSellInstruction({
  pool, globalConfig, user, baseMint,
  userBaseAta, userQuoteAta,
  poolBaseVault, poolQuoteVault,
  protocolFeeRecipient, protocolFeeAta,
  coinCreatorVault, coinCreatorVaultAta,
  eventAuthority, feeConfig,
  baseAmountIn, minQuoteAmountOut,
}) {
  // 序列化参数（Borsh: u64 LE × 2）
  const data = Buffer.alloc(8 + 8 + 8);
  SELL_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(BigInt(baseAmountIn), 8);
  data.writeBigUInt64LE(BigInt(minQuoteAmountOut), 16);

  const keys = [
    { pubkey: pool,                     isSigner: false, isWritable: true  },  // 0
    { pubkey: globalConfig,             isSigner: false, isWritable: false },  // 1
    { pubkey: user,                     isSigner: true,  isWritable: true  },  // 2
    { pubkey: baseMint,                 isSigner: false, isWritable: false },  // 3
    { pubkey: WSOL_MINT,                isSigner: false, isWritable: false },  // 4
    { pubkey: userBaseAta,              isSigner: false, isWritable: true  },  // 5
    { pubkey: userQuoteAta,             isSigner: false, isWritable: true  },  // 6
    { pubkey: poolBaseVault,            isSigner: false, isWritable: true  },  // 7
    { pubkey: poolQuoteVault,           isSigner: false, isWritable: true  },  // 8
    { pubkey: protocolFeeRecipient,     isSigner: false, isWritable: true  },  // 9
    { pubkey: protocolFeeAta,           isSigner: false, isWritable: true  },  // 10
    { pubkey: TOKEN_PROGRAM_ID,         isSigner: false, isWritable: false },  // 11
    { pubkey: TOKEN_PROGRAM_2022,       isSigner: false, isWritable: false },  // 12
    { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },  // 13
    { pubkey: ASSOC_TOKEN_PROGRAM,      isSigner: false, isWritable: false },  // 14
    { pubkey: coinCreatorVault,         isSigner: false, isWritable: true  },  // 15
    { pubkey: coinCreatorVaultAta,      isSigner: false, isWritable: true  },  // 16
    { pubkey: eventAuthority,           isSigner: false, isWritable: false },  // 17
    { pubkey: PUMP_AMM_PROGRAM_ID,      isSigner: false, isWritable: false },  // 18
    { pubkey: feeConfig,                isSigner: false, isWritable: false },  // 19
    { pubkey: FEE_PROGRAM_ID,           isSigner: false, isWritable: false },  // 20
  ];

  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys,
    data,
  });
}

// ── 主函数：直接卖出 ──────────────────────────────────────────
// poolAddress: 买入时从 transactionSubscribe 的 accountKeys 里记录的 pool 地址
// tokenMint:   token mint 地址
// tokenAmount: 卖出数量（raw units）
// isRug:       true = 接受任何价格（min_quote_out = 0）
async function sellViaAMM({ conn, keypair, poolAddress, tokenMint, tokenAmount, isRug = false }) {
  const startMs = Date.now();

  const baseMint  = new PublicKey(tokenMint);
  const poolPk    = new PublicKey(poolAddress);
  const userPk    = keypair.publicKey;

  // 1. 从 pool 账户读取 creator、vault 地址
  const { creator, poolBaseVault, poolQuoteVault } = await fetchPoolInfo(conn, poolPk);

  // 2. 推导所有 PDA 和 ATA
  const globalConfig   = findGlobalConfigPda();
  const eventAuthority = findEventAuthorityPda();
  const feeConfig      = findFeeConfigPda();

  // 用户的 token ATA 和 WSOL ATA
  const userBaseAta  = findAta(userPk, baseMint);
  const userQuoteAta = findAta(userPk, WSOL_MINT);

  // 协议费收款方（取第0个，rotate 也可以）
  const protocolFeeRecipient = PROTOCOL_FEE_RECIPIENTS[0];
  const protocolFeeAta       = findAta(protocolFeeRecipient, baseMint);

  // creator fee vault（creator 的 token ATA）
  const coinCreatorVault    = creator;           // creator 本人钱包
  const coinCreatorVaultAta = findAta(creator, baseMint);

  // 3. 计算 min_quote_out（滑点保护）
  const slippage = isRug ? 1.0 : 0.5;  // RUG时接受任何价格（100%滑点）
  const minQuoteOut = await calcMinQuoteOut(
    conn, poolBaseVault, poolQuoteVault, tokenAmount, slippage
  );

  // 4. 构建指令
  const sellIx = buildSellInstruction({
    pool:                 poolPk,
    globalConfig,
    user:                 userPk,
    baseMint,
    userBaseAta,
    userQuoteAta,
    poolBaseVault,
    poolQuoteVault,
    protocolFeeRecipient,
    protocolFeeAta,
    coinCreatorVault,
    coinCreatorVaultAta,
    eventAuthority,
    feeConfig,
    baseAmountIn:       tokenAmount,
    minQuoteAmountOut:  minQuoteOut,
  });

  // 5. 加 ComputeBudget（priority fee）
  const priorityFee = isRug
    ? parseInt(process.env.RUG_PRIORITY_FEE_LAMPORTS || '500000')
    : parseInt(process.env.PRIORITY_FEE_LAMPORTS     || '100000');

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  tx.add(sellIx);

  // 6. 发送并确认
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = userPk;

  const sig = await sendAndConfirmTransaction(conn, tx, [keypair], {
    commitment:          'confirmed',
    skipPreflight:       true,   // 跳过模拟，减少延迟
    maxRetries:          3,
  });

  const elapsed = Date.now() - startMs;
  logger.warn(`[PumpAmm] SELL OK sig=${sig.slice(0, 12)} elapsed=${elapsed}ms`);

  // 从 pool vault 余额变化估算实际收到的 SOL
  // （简化：用 min_quote_out 作为下限估计，实际可能更多）
  const solReceivedEst = Number(minQuoteOut) / LAMPORTS_PER_SOL;

  return { signature: sig, solReceived: solReceivedEst, elapsed };
}

module.exports = {
  sellViaAMM,
  findPoolPda,
  // 导出供 rugWatcher 记录 pool 地址用
  PUMP_AMM_PROGRAM_ID: PUMP_AMM_PROGRAM_ID.toBase58(),
};
