import { Chain } from "viem";

export const chains: readonly Chain[] = [
    {
      id: 8453,
      name: "Base",
      nativeCurrency: {
        name: "Ether",
        symbol: "ETH",
        decimals: 18,
      },
      rpcUrls: {
        default: {
          http: ["https://mainnet.base.org"],
        },
      },
      blockExplorers: {
        default: {
          name: "Basescan",
          url: "https://basescan.org",
          apiUrl: "https://api.basescan.org/api",
        },
      },
      contracts: {
        multicall3: {
          address: "0xca11bde05977b3631167028862be2a173976ca11",
          blockCreated: 5022,
        },
      },
    },
    {
      id: 42161,
      name: "Arbitrum One",
      nativeCurrency: {
        name: "Ether",
        symbol: "ETH",
        decimals: 18,
      },
      rpcUrls: {
        default: {
          http: ["https://arb1.arbitrum.io/rpc"],
        },
      },
      blockExplorers: {
        default: {
          name: "Arbiscan",
          url: "https://arbiscan.io",
          apiUrl: "https://api.arbiscan.io/api",
        },
      },
      contracts: {
        multicall3: {
          address: "0xca11bde05977b3631167028862be2a173976ca11",
          blockCreated: 7654707,
        },
      },
    },
    {
      id: 10,
      name: "OP Mainnet",
      nativeCurrency: {
        name: "Ether",
        symbol: "ETH",
        decimals: 18,
      },
      rpcUrls: {
        default: {
          http: ["https://mainnet.optimism.io"],
        },
      },
      blockExplorers: {
        default: {
          name: "Optimistic Etherscan",
          url: "https://optimistic.etherscan.io",
          apiUrl: "https://api-optimistic.etherscan.io/api",
        },
      },
      contracts: {
        multicall3: {
          address: "0xca11bde05977b3631167028862be2a173976ca11",
          blockCreated: 4286263,
        },
      },
    },
    {
      id: 747474,
      name: "Katana",
      nativeCurrency: {
        name: "Ether",
        symbol: "ETH",
        decimals: 18,
      },
      rpcUrls: {
        default: {
          http: ["https://rpc.katana.network"],
        },
      },
      blockExplorers: {
        default: {
          name: "Katana Explorer",
          url: "https://explorer.katanarpc.com",
        },
      },
      contracts: {
        multicall3: {
          // abhi Katana pe multicall3 deployed nahi hai (placeholder address)
          address: "0x0000000000000000000000000000000000000000",
          blockCreated: 0,
        },
      }
    },{
      "id": 11155111,
      "name": "Sepolia",
      "nativeCurrency": {
          "name": "Sepolia Ether",
          "symbol": "ETH",
          "decimals": 18
      },
      "rpcUrls": {
          "default": {
              "http": [
                  "https://rpc.sepolia.org"
              ]
          }
      },
      "blockExplorers": {
          "default": {
              "name": "Etherscan",
              "url": "https://sepolia.etherscan.io",
              "apiUrl": "https://api-sepolia.etherscan.io/api"
          }
      },
      "contracts": {
          "multicall3": {
              "address": "0xca11bde05977b3631167028862be2a173976ca11",
              "blockCreated": 751532
          },
          "ensRegistry": {
              "address": "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e"
          },
          "ensUniversalResolver": {
              "address": "0xc8Af999e38273D658BE1b921b88A9Ddf005769cC",
              "blockCreated": 5317080
          }
      },
      "testnet": true
    }
  ] as const
  
  

  
  export const networkOptions = [
    {
      id: "base",
      name: "Base",
      icon: "/icons/base-icon.svg",
      chainId: "0x2105",
      rpcUrl: "https://mainnet.base.org/",
      blockExplorerUrl: "https://base.blockscout.com/",
    },
    {
      id: "arbitrum",
      name: "Arbitrum One",
      icon: "/icons/arbitrum-icon.svg",
      chainId: "0xa4b1",
      rpcUrl: "https://arb1.arbitrum.io/rpc/",
      blockExplorerUrl: "https://arbiscan.io/",
    },
    {
      id: "optimism",
      name: "OP Mainnet",
      icon: "/icons/optimism-icon.svg",
      chainId: "0xa",
      rpcUrl: "https://mainnet.optimism.io/",
      blockExplorerUrl: "https://optimistic.etherscan.io/",
    },
    {
      id: "katana",
      name: "Katana",
      icon: "/icons/katana.jpg", // apna custom icon rakhna
      chainId: "0xB6B6A", // 747474 in hex
      rpcUrl: "https://rpc.katana.network/",
      blockExplorerUrl: "https://explorer.katanarpc.com/",
    }  
  ];
  
  export const BASE_NETWORK = "base";
  export const ARBITRUM_NETWORK = "arbitrum";
  export const OPTIMISM_NETWORK = "optimism";
  
  export const SECS_PER_YEAR = 31556952;
  export const FEES = 0.01;
  export const oneMonthTimestampInterval = 2629743;
  export const referralCode =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
  export const percentageClickValues = [10, 25, 50, 100]
  