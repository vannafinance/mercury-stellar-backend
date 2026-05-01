export const FILTER_OPTIONS = ["3 Months", "6 Months", "1 Year", "All Time"]

// Overall Deposit Data - Monthly data for approximately one year (Jan 2025 - Dec 2025)
export const depositData = [
    { date: "2025-01-01", amount: 850 },
    { date: "2025-01-15", amount: 920 },
    { date: "2025-02-01", amount: 980 },
    { date: "2025-02-15", amount: 1050 },
    { date: "2025-03-01", amount: 1120 },
    { date: "2025-03-15", amount: 1180 },
    { date: "2025-04-01", amount: 1250 },
    { date: "2025-04-15", amount: 1320 },
    { date: "2025-05-01", amount: 1400 },
    { date: "2025-05-15", amount: 1480 },
    { date: "2025-06-01", amount: 1560 },
    { date: "2025-06-15", amount: 1650 },
    { date: "2025-07-01", amount: 1740 },
    { date: "2025-07-15", amount: 1830 },
    { date: "2025-08-01", amount: 1920 },
    { date: "2025-08-15", amount: 2020 },
    { date: "2025-09-01", amount: 2120 },
    { date: "2025-09-15", amount: 2230 },
    { date: "2025-10-01", amount: 2350 },
    { date: "2025-10-15", amount: 2470 },
    { date: "2025-11-01", amount: 2600 },
    { date: "2025-11-15", amount: 2740 },
    { date: "2025-12-01", amount: 2890 },
    { date: "2025-12-15", amount: 3050 },
    { date: "2025-12-31", amount: 3220 },
]

// Net APY Data - Monthly data showing APY earnings in USD (Jan 2025 - Dec 2025)
export const netApyData = [
    { date: "2025-01-01", amount: 12.50 },
    { date: "2025-01-15", amount: 18.20 },
    { date: "2025-02-01", amount: 24.80 },
    { date: "2025-02-15", amount: 31.50 },
    { date: "2025-03-01", amount: 38.90 },
    { date: "2025-03-15", amount: 46.20 },
    { date: "2025-04-01", amount: 54.10 },
    { date: "2025-04-15", amount: 62.30 },
    { date: "2025-05-01", amount: 71.20 },
    { date: "2025-05-15", amount: 80.50 },
    { date: "2025-06-01", amount: 90.10 },
    { date: "2025-06-15", amount: 100.20 },
    { date: "2025-07-01", amount: 110.80 },
    { date: "2025-07-15", amount: 122.10 },
    { date: "2025-08-01", amount: 133.90 },
    { date: "2025-08-15", amount: 146.20 },
    { date: "2025-09-01", amount: 159.10 },
    { date: "2025-09-15", amount: 172.80 },
    { date: "2025-10-01", amount: 187.20 },
    { date: "2025-10-15", amount: 202.30 },
    { date: "2025-11-01", amount: 218.10 },
    { date: "2025-11-15", amount: 234.60 },
    { date: "2025-12-01", amount: 251.90 },
    { date: "2025-12-15", amount: 270.10 },
    { date: "2025-12-31", amount: 289.20 },
]     

export const tableHeadings = [
    { label: "Pool", id: "pool" },
    { label: "Assets Supplied", id: "assets-supplied" ,icon:true},
    { label: "Supply APY", id: "supply-apy" ,icon:true},
    { label: "Assets Borrowed", id: "assets-borrowed" ,icon:true},
    { label: "Borrow APY", id: "borrow-apy" ,icon:true},
    { label: "Utilization Rate", id: "utilization-rate" ,icon:true},
    { label: "Collateral", id: "collateral" },
  ]

// Stellar Blockchain Pool Data
export const tableBody = {
  rows: [
    {
      cell: [
        {
          chain: "XLM",
          title: "XLM",
          tag: "Active",
        },
        {
          title: "$125.4K",
          tag: "1.25M XLM",
        },
        {
          title: "8.45%",
          tag: "8.45%",
        },
        {
          title: "$45.2K",
          tag: "452K XLM",
        },
        {
          title: "6.25%",
          tag: "6.25%",
        },
        {
          title: "36.05%",
          tag: "36.05%",
        },
        {
          onlyIcons: ["XLM", "USDC"],
          tag: "Collateral",
          clickable: "toggle",
        },
      ],
    },
    {
      cell: [
        {
          chain: "BLUSDC",
          title: "BLUSDC",
          tag: "Active",
        },
        {
          title: "$892.4K",
          tag: "892.4K USDC",
        },
        {
          title: "5.75%",
          tag: "5.75%",
        },
        {
          title: "$312.8K",
          tag: "312.8K USDC",
        },
        {
          title: "4.85%",
          tag: "4.85%",
        },
        {
          title: "35.05%",
          tag: "35.05%",
        },
        {
          onlyIcons: ["BLUSDC", "XLM"],
          tag: "Collateral",
          clickable: "toggle",
        },
      ],
    },
    {
      cell: [
        {
          chain: "AqUSDC",
          title: "AqUSDC",
          tag: "Active",
        },
        {
          title: "0 AqUSDC",
          tag: "0.0000 AqUSDC",
        },
        {
          title: "2.50%",
          tag: "2.50%",
        },
        {
          title: "0 AqUSDC",
          tag: "0.0000 AqUSDC",
        },
        {
          title: "4.00%",
          tag: "4.00%",
        },
        {
          title: "0.00%",
          tag: "0.00%",
        },
        {
          onlyIcons: ["BLUSDC", "XLM"],
          tag: "Collateral",
          clickable: "toggle",
        },
      ],
    },
  ],
};

// Pool configuration with contract addresses (Stellar Testnet)
export const STELLAR_POOLS = {
  XLM: {
    id: 'XLM',
    name: 'Stellar Lumens',
    symbol: 'XLM',
    icon: '/icons/usdc-icon.svg', // Placeholder - replace with proper XLM icon
    decimals: 7,
    lendingProtocol: 'CAOPI6NYPXEVMDRTUWAGMWNSIXMBCBDSJBJARLIUJB6LNRPQCCJUN3VO',
    vToken: 'CC7XU2DPNVYB5FFNX7XR4LEEEZFOSLTOBSCY6AXXIYUONYKTFMLYZ4ZT',
    nativeContract: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  },
  USDC: {
    id: 'USDC',
    name: 'USD Coin',
    symbol: 'BLUSDC',
    icon: '/icons/usdc-icon.svg',
    decimals: 7,
    lendingProtocol: 'CBMZVGZCQWI35OYTLH7PLHJXFE7GHXD5CTNT2CYWBD4URVKTWQQRVN3Q',
    vToken: 'CCN6O2Y2KKXZCFDEI7XI2W3K4SVI2634YEPRTJVKAYS22QH3QFQNS5FO',
    nativeContract: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',
  },
  AQUARIUS_USDC: {
    id: 'AQUARIUS_USDC',
    name: 'Aquarius USD Coin',
    symbol: 'AqUSDC',
    icon: '/icons/usdc-icon.svg',
    decimals: 7,
    issuer: 'GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER',
    nativeContract: 'CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5',
    lendingProtocol: 'CCIC7KKEZFONJSDRIML2MEWDC67DVHRGVTUYP6UPR4UQURPCB44O6N5D',
    vToken: 'CCY44CN4V725LP2PQBLTM27Q3UEGNM76PKVG7IZF3L74DX4FLSDUJA7S',
  },
  SOROSWAP_USDC: {
    id: 'SOROSWAP_USDC',
    name: 'Soroswap USD Coin',
    symbol: 'SoUSDC',
    icon: '/icons/usdc-icon.svg',
    decimals: 7,
    nativeContract: 'CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F',
    lendingProtocol: 'CA55DFIQG6O2VO4PW23LSG7VQH45HQ3KG75N4VVIJCLQKULT4Z7BMS32',
    vToken: 'CCMI4Y6LQ7SA3WKBEK463IG47EBBJ4UCCOQNPC7RTYN53ARJ63J55DZD',
  },
} as const;

// Supported assets for dropdown
export const STELLAR_ASSETS = ['XLM', 'USDC', 'AQUARIUS_USDC', 'SOROSWAP_USDC'] as const;
export type StellarAsset = typeof STELLAR_ASSETS[number];
