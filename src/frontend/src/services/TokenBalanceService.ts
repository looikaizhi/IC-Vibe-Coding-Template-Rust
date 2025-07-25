// Token Balance Query Service

import { Actor, HttpAgent, ActorSubclass } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { IDL } from "@dfinity/candid";

// Account interface
export interface Account {
  owner: Principal;
  subaccount?: Uint8Array | null;
}

// ICRC Ledger interface
export interface ICRCLedger {
  icrc1_balance_of: (args: {
    account: { owner: Principal; subaccount: Uint8Array[] | [] };
  }) => Promise<bigint>;
  icrc1_name: () => Promise<string>;
  icrc1_symbol: () => Promise<string>;
  icrc1_decimals: () => Promise<number>;
}

// ICRC Ledger IDL
const icrc1Idl: IDL.InterfaceFactory = ({ IDL }) =>
  IDL.Service({
    icrc1_balance_of: IDL.Func(
      [
        IDL.Record({
          account: IDL.Record({
            owner: IDL.Principal,
            subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
          }),
        }),
      ],
      [IDL.Nat],
      ["query"],
    ),
    icrc1_name: IDL.Func([], [IDL.Text], ["query"]),
    icrc1_symbol: IDL.Func([], [IDL.Text], ["query"]),
    icrc1_decimals: IDL.Func([], [IDL.Nat8], ["query"]),
  });

export class TokenBalanceService {
  private agent: HttpAgent;
  private tokenInfoCache: Map<
    string,
    { name: string; symbol: string; decimals: number }
  >;

  constructor(agent: HttpAgent) {
    this.agent = agent;
    this.tokenInfoCache = new Map();
    const network = import.meta.env.DFX_NETWORK || "ic";
    if (network === "local") {
      this.agent
        .fetchRootKey()
        .catch((error) => console.error("获取本地 Root Key 失败:", error));
    }
  }

  // Get network configuration
  private getNetworkConfig() {
    const network = import.meta.env.DFX_NETWORK || "ic";
    if (!["local", "ic"].includes(network)) {
      throw new Error(
        `无效的 DFX_NETWORK 值: ${network}，应为 "local" 或 "ic"`,
      );
    }
    const isLocal = network === "local";
    const host = isLocal ? "http://localhost:4943" : "https://icp-api.io";
    return { network, isLocal, host };
  }

  // Generate Account from Principal
  generateAccountFromPrincipal(
    principal: Principal,
    subaccount?: Uint8Array,
  ): Account {
    return {
      owner: principal,
      subaccount: subaccount ?? undefined,
    };
  }

  // Generate default Account (no subaccount)
  generateDefaultAccount(principal: Principal): Account {
    return this.generateAccountFromPrincipal(principal);
  }

  // Query token balance
  async queryTokenBalance(
    tokenCanisterId: string,
    principal: Principal,
    subaccount?: Uint8Array,
  ): Promise<{ balance?: bigint; error?: string }> {
    try {
      console.log(
        `Querying token balance: Canister=${tokenCanisterId}, Principal=${principal.toText()}, Subaccount=${
          subaccount ? this.toHex(subaccount) : "none"
        }`,
      );

      const actor = Actor.createActor<ICRCLedger>(icrc1Idl, {
        agent: this.agent,
        canisterId: tokenCanisterId,
      });

      // 正确处理subaccount参数 - ICRC-1期望opt vec nat8
      const account = {
        owner: principal,
        subaccount: subaccount ? [subaccount] : [], // 转换为opt vec nat8格式
      };

      const balance = await actor.icrc1_balance_of({ account });
      console.log(`Balance retrieved: ${balance}`);
      return { balance };
    } catch (error) {
      console.error("Failed to query token balance:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        error: `Failed to query ${tokenCanisterId} balance: ${errorMessage}`,
      };
    }
  }

  // Generate Account ID
  async generateAccountId(
    principal: Principal,
    subaccount?: Uint8Array,
  ): Promise<string> {
    try {
      const padding = new Uint8Array([
        0x0a,
        ...new TextEncoder().encode("account-id"),
      ]);
      const principalBytes = principal.toUint8Array();
      const sub = subaccount ?? new Uint8Array(32);
      const data = new Uint8Array(
        padding.length + principalBytes.length + sub.length,
      );
      data.set(padding, 0);
      data.set(principalBytes, padding.length);
      data.set(sub, padding.length + principalBytes.length);

      // SHA-224 hash
      const hashBuffer = await crypto.subtle.digest("SHA-224", data);
      const hash = new Uint8Array(hashBuffer);

      // CRC32 checksum
      const crc32 = this.calculateCRC32(hash);
      const result = new Uint8Array(4 + hash.length);
      result.set(crc32, 0);
      result.set(hash, 4);

      return this.toHex(result);
    } catch (error) {
      console.error("Failed to generate Account ID:", error);
      throw error;
    }
  }

  // Get token information
  async getTokenInfo(tokenCanisterId: string): Promise<{
    name: string;
    symbol: string;
    decimals: number;
  }> {
    try {
      if (this.tokenInfoCache.has(tokenCanisterId)) {
        return this.tokenInfoCache.get(tokenCanisterId)!;
      }

      console.log(`Fetching token info for ${tokenCanisterId}`);
      const actor = Actor.createActor<ICRCLedger>(icrc1Idl, {
        agent: this.agent,
        canisterId: tokenCanisterId,
      });

      const [name, symbol, decimals] = await Promise.all([
        actor.icrc1_name(),
        actor.icrc1_symbol(),
        actor.icrc1_decimals(),
      ]);

      const tokenInfo = { name, symbol, decimals: Number(decimals) };
      this.tokenInfoCache.set(tokenCanisterId, tokenInfo);
      return tokenInfo;
    } catch (error) {
      console.warn(
        `Failed to fetch ${tokenCanisterId} token info, using default:`,
        error,
      );
      return { name: "Unknown Token", symbol: "", decimals: 8 };
    }
  }

  // Format balance display
  formatBalance(balance: bigint, decimals: number): string {
    const divisor = BigInt(10 ** decimals);
    const whole = balance / divisor;
    const fraction = balance % divisor;

    if (fraction === BigInt(0)) {
      return whole.toString();
    }

    const fractionStr = fraction
      .toString()
      .padStart(decimals, "0")
      .replace(/0+$/, "");
    return `${whole}.${fractionStr}`;
  }

  // Calculate CRC32 checksum
  private calculateCRC32(data: Uint8Array): Uint8Array {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) {
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
    }
    crc = ~crc >>> 0;
    const buffer = new Uint8Array(4);
    buffer[0] = (crc >> 24) & 0xff;
    buffer[1] = (crc >> 16) & 0xff;
    buffer[2] = (crc >> 8) & 0xff;
    buffer[3] = crc & 0xff;
    return buffer;
  }

  // Convert byte array to hex string
  private toHex(buffer: Uint8Array): string {
    return Array.from(buffer)
      .map((x) => ("00" + x.toString(16)).slice(-2))
      .join("");
  }
}

// Common token Canister IDs
export const TOKEN_CANISTER_IDS = {
  ICP: "ryjl3-tyaaa-aaaaa-aaaba-cai",
  CKBTC: "mxzaz-hqaaa-aaaar-qaada-cai",
  SNS1: "zfcdd-tqaaa-aaaaq-aaaga-cai",
  LOCAL_ICP: import.meta.env.LOCAL_ICP_CANISTER_ID || "",
  LOCAL_CKBTC: import.meta.env.LOCAL_CKBTC_CANISTER_ID || "",
};

// Create global instance
export function createTokenBalanceService(
  agent: HttpAgent,
): TokenBalanceService {
  return new TokenBalanceService(agent);
}
