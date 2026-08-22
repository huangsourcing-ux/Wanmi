import type {
  AftermarketCard,
  AuctionListing,
  BentoCard,
  FaqEntry,
  FeatureRow,
  FooterColumn,
  MegaPanel,
  NavItem,
  ResourceCard,
  StatItem,
  WhyBlock,
} from "@/types/dynadot";

export const ASSETS = "/sites/www-dynadot-com-7f8c2392/root-8a5edab2";

export const ANNOUNCEMENT =
  "✨ Transfer your .COM for just $10.49. Don't forget to use the code COMSUMMER26";

export const PRIMARY_NAV: NavItem[] = [
  { label: "Domains", href: "#" },
  { label: "Aftermarket", href: "#" },
  { label: "Tools", href: "#" },
  { label: "Resources", href: "#" },
  { label: "Support", href: "#" },
];

/**
 * Hover mega-menu panels, extracted by hovering each nav item on the source.
 * Panel: `position: absolute`, `top: 111` (banner 39 + navbar 72), full width,
 * `background: #031242`, `padding: 45px 0 0`, `z-index: 9999`, height 327.
 * Inner row: `padding: 0 85px`. Column: `gap: 10px`, `padding: 0 30px`.
 * Lead heading 24px/500 white; column headings 18px/500 white at 40% opacity;
 * links 16px/400 white.
 */
export const MEGA_PANELS: MegaPanel[] = [
  {
    label: "Domains",
    title: "Domains",
    lead: "Find Your Domain",
    columnWidth: 345,
    columns: [
      {
        heading: "Search",
        links: [
          { label: "Domain Search", href: "#" },
          { label: "AI Domain Search", href: "#" },
          { label: "Bulk Domain Search", href: "#" },
          { label: "Advanced Search", href: "#" },
          { label: "IDNs Search", href: "#" },
        ],
      },
      {
        heading: "Transfer",
        links: [
          { label: "Domain Transfer", href: "#" },
          { label: "Bulk Domain Transfer", href: "#" },
        ],
      },
      {
        heading: "TLDs",
        links: [
          { label: "Domain Prices", href: "#" },
          { label: "Domain Sales", href: "#" },
        ],
      },
      {
        heading: "Domain Tools",
        links: [
          { label: "Whois Lookup", href: "#" },
          { label: "Suggestion Tool", href: "#" },
          { label: "Grace Deletion", href: "#" },
          { label: "Domain Security", href: "#" },
          { label: "Domain Management", href: "#" },
          { label: "API", href: "#" },
          { label: "Appraisals", href: "#" },
        ],
      },
    ],
  },
  {
    label: "Aftermarket",
    title: "Aftermarket",
    lead: "Manage Your Portfolio",
    promo: {
      title: "Explore Our",
      body: "Premium",
      cta: "Marketplace",
    },
    columnWidth: 290,
    columns: [
      {
        heading: "Explore",
        links: [
          { label: "Aftermarket Search", href: "#" },
          { label: "All Domain Auctions", href: "#" },
        ],
      },
      {
        heading: "Expired Domains",
        links: [
          { label: "Expired Auctions", href: "#" },
          { label: "Registry Auctions", href: "#" },
          { label: "Last Chance Auctions", href: "#" },
          { label: "Expired Closeout", href: "#" },
        ],
      },
      {
        heading: "User Listings",
        links: [
          { label: "Buy It Now", href: "#" },
          { label: "User Auctions", href: "#" },
          { label: "Pre-Expiry Auctions", href: "#" },
          { label: "Premium User Auction", href: "#" },
        ],
      },
      {
        heading: "Backorder Tools",
        links: [
          { label: "Backorder", href: "#" },
          { label: "Backorder Auctions", href: "#" },
        ],
      },
      {
        heading: "Brokerage Services",
        links: [
          { label: "Buy Domains", href: "#" },
          { label: "Sell Domains", href: "#" },
        ],
      },
    ],
  },
  {
    label: "Tools",
    title: "Tools",
    promo: {
      title: "tiny . BIO",
      body: "Your entire bio on one page",
      cta: "Get Started",
    },
    columnWidth: 345,
    columns: [
      {
        heading: "Tools",
        links: [
          { label: "Website Builder", href: "#" },
          { label: "Email", href: "#" },
          { label: "Logo Maker", href: "#" },
          { label: "SSL", href: "#" },
          { label: "Security", href: "#" },
          { label: "Reseller Program", href: "#" },
          { label: "Trademark Search", href: "#" },
        ],
      },
      {
        heading: "Platform Partners",
        links: [
          { label: "Wix Website Builder", href: "#" },
          { label: "tiny.BIO", href: "#" },
        ],
      },
    ],
  },
  {
    label: "Resources",
    title: "Resources",
    lead: "Manage Your Portfolio",
    columnWidth: 290,
    columns: [
      {
        heading: "Resources",
        links: [
          { label: "Dynadot Blog", href: "#" },
          { label: "Newsletters", href: "#" },
        ],
      },
      {
        heading: "Payment Methods",
        links: [
          { label: "Payment Options", href: "#" },
          { label: "Prepay", href: "#" },
        ],
      },
      {
        heading: "Learning",
        links: [
          { label: "Domain Name Basics Guide", href: "#" },
          { label: "Domain Investing Guide", href: "#" },
          { label: "How to Buy Domains", href: "#" },
          { label: "How to Sell Domains", href: "#" },
        ],
      },
      {
        heading: "Affiliate",
        links: [{ label: "General Affiliate Program", href: "#" }],
      },
      {
        heading: "Reseller Program",
        links: [{ label: "Reseller Program", href: "#" }],
      },
    ],
  },
  {
    label: "Support",
    title: "Support",
    columnWidth: 345,
    columns: [
      {
        heading: "Help Center",
        links: [
          { label: "Account Manager Request", href: "#" },
          { label: "Help Files", href: "#" },
          { label: "Forums", href: "#" },
        ],
      },
      {
        heading: "Support Tools",
        links: [
          { label: "Contact Us", href: "#" },
          { label: "Support Tickets", href: "#" },
          { label: "Report Abuse", href: "#" },
          { label: "Report Bugs", href: "#" },
          { label: "Feature Requests", href: "#" },
        ],
      },
    ],
  },
];

export const SEARCH_TABS = [
  "Register",
  "Transfer",
  "AI Search",
  "Bulk Search",
] as const;

export const STATS: StatItem[] = [
  { value: "11M+", label: "Domains" },
  { value: "1M+", label: "Customers" },
  { value: "800+", label: "TLDs" },
  { value: "24/7", label: "Support" },
];

/**
 * Auction listings are live, server-generated data on the source page — bids
 * and countdowns change every session. Snapshotted here as static mock data.
 */
export const HOT_AUCTIONS: AuctionListing[] = [
  { domain: "jpav.com", price: "$2026.00", bids: 79, endsIn: "1h, 33m" },
  { domain: "imki.com", price: "$1358.00", bids: 92, endsIn: "2d, 4h" },
  {
    domain: "qiydata.net",
    price: "$749.90",
    bids: 74,
    endsIn: "6m",
    endingSoon: true,
  },
  {
    domain: "haocen.com",
    price: "$734.90",
    bids: 71,
    endsIn: "39m",
    endingSoon: true,
  },
  {
    domain: "szmaguan.com",
    price: "$1130.80",
    bids: 45,
    endsIn: "12m",
    endingSoon: true,
  },
  {
    domain: "szsdtek.net",
    price: "$734.90",
    bids: 66,
    endsIn: "21m",
    endingSoon: true,
  },
  { domain: "3bu.com", price: "$1258.88", bids: 33, endsIn: "13h, 19m" },
  { domain: "keria.com", price: "$1100.00", bids: 25, endsIn: "3d, 18h" },
  { domain: "nyhk.com", price: "$449.00", bids: 60, endsIn: "1d, 14h" },
  {
    domain: "embedgooglemap.org",
    price: "$695.00",
    bids: 38,
    endsIn: "1d, 14h",
  },
  { domain: "orapay.com", price: "$395.00", bids: 65, endsIn: "17h, 29m" },
  { domain: "conforto.com", price: "$787.00", bids: 28, endsIn: "3d, 14h" },
];

export const AFTERMARKET_TICKER: AuctionListing[] = [
  { domain: "imki.com", price: "$560.00", bids: 85 },
  { domain: "jpav.com", price: "$2026.00", bids: 79 },
  { domain: "orapay.com", price: "$395.00", bids: 65 },
  { domain: "xycj.com", price: "$89.00", bids: 63 },
  { domain: "nyhk.com", price: "$449.00", bids: 60 },
  { domain: "kmmy.com", price: "$449.00", bids: 40 },
  { domain: "wellnesshut.com", price: "$67.00", bids: 39 },
  { domain: "embedgooglemap.org", price: "$695.00", bids: 38 },
  { domain: "yhav.com", price: "$100.00", bids: 34 },
  { domain: "hnxx.com", price: "$137.90", bids: 34 },
  { domain: "3bu.com", price: "$1258.88", bids: 33 },
  { domain: "omnicarehospice.com", price: "$205.00", bids: 33 },
  { domain: "seqdb.com", price: "$30.00", bids: 31 },
  { domain: "pbx.net", price: "$504.00", bids: 31 },
  { domain: "mrai.org", price: "$54.00", bids: 29 },
  { domain: "ctyp.com", price: "$147.00", bids: 29 },
  { domain: "zenkos.com", price: "$36.00", bids: 29 },
  { domain: "fivetrust.com", price: "$53.00", bids: 29 },
  { domain: "conforto.com", price: "$787.00", bids: 28 },
  { domain: "ce88.com", price: "$105.00", bids: 28 },
];

export const FEATURE_ROWS: FeatureRow[] = [
  {
    title: "Buy a Domain Name",
    body: "Building your online presence starts with buying the right domain name. Get competitive prices, expert tools, and free privacy protection when you search from over 500 TLDs to find a domain that fits your brand.",
    cta: "Search Available Domains",
    image: `${ASSETS}/images/domain-entry-buy.webp`,
    alt: "buy domain",
    imageRight: true,
  },
  {
    title: "Transfer a Domain Name",
    body: "Already own a domain? Transfer your domain name to Dynadot for better pricing, zero upselling, and streamlined domain management.",
    cta: "Transfer Your Domains",
    image: `${ASSETS}/images/domain-entry-transfer.webp`,
    alt: "transfer domain",
    imageRight: false,
  },
];

export const AFTERMARKET_CARDS: AftermarketCard[] = [
  {
    title: "Expired Domains",
    body: "Access premium expired domain names daily. Find high-value domains to buy for branding, SEO, or domain investing.",
    cta: "Browse Expired Domains",
    icon: `${ASSETS}/images/expired-domain-left-icon.png`,
    alt: "expired domains icon",
  },
  {
    title: "Domain Backorders",
    body: "Place a backorder on a domain name that is about to expire and let us chase it for you the moment it drops.",
    cta: "Place a Backorder",
    icon: `${ASSETS}/images/domain-backorders-left-icon.png`,
    alt: "domain backorder icon",
  },
  {
    title: "User Listings",
    body: "Browse domain names listed for sale directly by their owners, with buy-it-now pricing and offer negotiation.",
    cta: "Explore User Listings",
    icon: `${ASSETS}/images/user-listings-left-icon.png`,
    alt: "user listing icon",
  },
];

/**
 * Horizontal accordion cards. Gradients are the verbatim computed
 * `background-image` of each `.build-tools-card-*` on the source.
 */
export const BENTO_CARDS: BentoCard[] = [
  {
    title: "Your Dream Site, Our Website Builder",
    body: "Turn your domain name into a live website in minutes using our intuitive drag-and-drop website builder.",
    cta: "Build Your Website Easily",
    image: `${ASSETS}/images/website-builder.webp`,
    alt: "website builder",
    gradient:
      "radial-gradient(158.64% 140.35% at 0.11% 0px, #0096F7 14.22%, #34AFFF 42.51%, #FFFFFF 80%)",
  },
  {
    title: "Setup Custom Email",
    body: "Create a professional email address that matches your domain name and builds trust with every email sent.",
    cta: "Get a Professional Email",
    image: `${ASSETS}/images/professional-email.webp`,
    alt: "professional email",
    gradient:
      "radial-gradient(188.95% 141.42% at 0px 0px, #D36EFF 16.89%, #E099FF 52.38%, #FFFFFF 73%), radial-gradient(143.21% 141.42% at 0px 0px, #D36EFF 0px, rgba(211,110,255,0.5))",
  },
  {
    title: "Assemble Your Logo",
    body: "Bring your domain name to life with a unique visual identity using our AI-powered logo builder.",
    cta: "Build Your Brand Logo",
    image: `${ASSETS}/images/logo-builder-icon.webp`,
    alt: "logo builder",
    gradient:
      "radial-gradient(201.15% 141.42% at 0px 0px, #FFCA2B 23.63%, #FFD351 50.14%, #FFFFFF 73%)",
  },
  {
    title: "Manage on the Go",
    body: "Buy a domain name, manage it, and monitor it anywhere with the Dynadot mobile app.",
    cta: "Access Domains Anywhere",
    image: `${ASSETS}/images/manage-on-go-icon.webp`,
    alt: "manage on go",
    gradient:
      "radial-gradient(201.03% 137.95% at 4.89% 0.08%, #031242 14.89%, #355BD3 37.89%, #CBD4F3 57.48%, #FFFFFF 68%)",
    titleOnDark: true,
  },
];

export const WHY_BLOCKS: WhyBlock[] = [
  {
    title: "Industry-low Domain Prices",
    body: "Buy domain names at competitive prices with no upselling and transparent renewal rates.",
    cta: "Start Saving",
    image: `${ASSETS}/images/why-dynadot-pointer-icon.webp`,
    alt: "why dynadot pointer icon",
  },
  {
    title: "Support Experts",
    body: "Get help at every stage of buying, transferring, or managing your domain name from our in-house support team. Available 24/7.",
    cta: "Reach Our Team",
    image: `${ASSETS}/images/why-dynadot-people-icon.webp`,
    alt: "why dynadot people icon",
  },
  {
    title: "Domain Management Made Easy",
    body: "Easily manage the domain names you buy using a flexible, powerful control panel built for scale.",
    cta: "Organize Your Domains",
    image: `${ASSETS}/images/why-dynadot-pie-icon.webp`,
    alt: "why dynadot pie icon",
  },
  {
    title: "Advanced Domain Security",
    body: "Protect the domain names you own with enterprise-grade security and account protection features.",
    cta: "Secure Your Domains",
    image: `${ASSETS}/images/why-dynadot-security-icon.webp`,
    alt: "why dynadot security icon",
  },
];

export const RESOURCE_CARDS: ResourceCard[] = [
  {
    title: "Help Files",
    body: "Step-by-step guides and tutorials to help you buy domain names and use all of Dynadot's tools effectively.",
    cta: "Find Support Articles",
  },
  {
    title: "Blog",
    body: "Insights on domain names, online business growth, industry trends, and Dynadot updates.",
    cta: "Discover Latest Insights",
  },
  {
    title: "Forum",
    body: "Connect with domain buyers, investors, and online entrepreneurs to share knowledge and strategies.",
    cta: "Join Our Community",
  },
];

/**
 * Question text matches the source accordion verbatim (short functional
 * labels). Answer bodies are written for this clone at comparable length so
 * the accordion panels lay out like the original without copying the source
 * site's long-form editorial content.
 */
export const FAQS: FaqEntry[] = [
  {
    question:
      "I'm buying a domain for the first time, what should I consider before registering it?",
    answer: [
      "Weigh four things before you commit: how well the name carries your brand, whether it collides with an existing trademark, how usable it stays as you grow, and the specific rules attached to the extension you pick.",
      "Short names that are easy to say and spell cost less to market. Run a trademark check first — a dispute can force a transfer or a full rebrand. And read the registry policy for the TLD, since some extensions restrict who may hold them or require local presence.",
    ],
  },
  {
    question: "How do I register a domain name?",
    answer: [
      "Search for the name you want, add the available result to your cart, choose a registration term, and check out. Registration is confirmed within moments and the name appears in your account control panel.",
    ],
  },
  {
    question: "How much does a domain name cost?",
    answer: [
      "Price depends on the extension. Common TLDs sit in the low double digits per year, while newer or specialty extensions vary widely. Renewal is charged at the published rate for that TLD — there is no introductory price that jumps later.",
    ],
  },
  {
    question: "What's included with domain registration?",
    answer: [
      "Every registration includes DNS management, URL and email forwarding, privacy protection where the registry permits it, and access to the full control panel — no add-on purchase required.",
    ],
  },
  {
    question: "What payment methods does Dynadot support?",
    answer: [
      "Major credit and debit cards, PayPal, wire transfer, and account credit are supported. Account credit is useful for bulk registrations and auction bidding because it settles instantly.",
    ],
  },
  {
    question: "Is there a way to register several domains at the same time?",
    answer: [
      "Yes. Bulk Search accepts a list of names or generates combinations across multiple TLDs, then registers everything available in a single checkout.",
    ],
  },
  {
    question: "What happens after I register a domain?",
    answer: [
      "The name is assigned to your account and you can point it at a site, set up email, or park it. You will also receive renewal reminders well ahead of the expiry date.",
    ],
  },
  {
    question:
      "How long does it take for a new domain name to be active after registering it?",
    answer: [
      "The registration itself completes immediately. DNS changes typically propagate within a few minutes, though some networks can take up to 24 hours to reflect them.",
    ],
  },
  {
    question:
      "How do I access and manage my domain settings once it's registered?",
    answer: [
      "Sign in and open the domain list in your control panel. From there you can edit nameservers, DNS records, contact details, forwarding, privacy, and transfer locks for one domain or in bulk.",
    ],
  },
  {
    question: "Do you offer domain privacy protection?",
    answer: [
      "Yes. Privacy replaces your personal contact details in the public Whois record with proxy information, at no extra cost for TLDs whose registries allow it.",
    ],
  },
  {
    question:
      "If I register a domain, do I have to put my real name/address in Whois?",
    answer: [
      "Registry rules require accurate registrant contact data on file. Privacy protection keeps those details out of the public Whois record while the accurate information stays on file with the registrar.",
    ],
  },
  {
    question: "What happens if I forget to renew my domain?",
    answer: [
      "An expired domain enters a grace period during which you can still renew at the normal rate. After that it moves to a redemption period with a recovery fee, and finally drops back into the available pool.",
    ],
  },
  {
    question: "Can I transfer my existing domain to Dynadot?",
    answer: [
      "Yes. Unlock the domain at your current registrar, obtain the authorization code, then start the transfer here. Transfers usually complete within five to seven days and add a year to the registration term.",
    ],
  },
  {
    question: "Why is my personal website offline?",
    answer: [
      "The usual causes are an expired registration, nameservers pointing somewhere other than your host, or a missing DNS record. Check the expiry date and the nameserver settings in your control panel first.",
    ],
  },
];

export const FOOTER_COLUMNS: FooterColumn[] = [
  {
    heading: "Domain",
    links: [
      { label: "Domain Search", href: "#" },
      { label: "Transfer", href: "#" },
      { label: "IDNs Search", href: "#" },
      { label: "TLD Prices", href: "#" },
      { label: "Domain Sales", href: "#" },
      { label: "Resellers", href: "#" },
      { label: "Websites", href: "#" },
      { label: "Email", href: "#" },
      { label: "SSL", href: "#" },
      { label: "Domain Suggestion Tool", href: "#" },
      { label: "Security", href: "#" },
      { label: "Grace Deletion", href: "#" },
      { label: "API", href: "#" },
      { label: "Whois Lookup", href: "#" },
      { label: "Payment Plan", href: "#" },
    ],
  },
  {
    heading: "Aftermarket",
    links: [
      { label: "Aftermarket Search", href: "#" },
      { label: "Market Overview", href: "#" },
      { label: "Buy It Now", href: "#" },
      { label: "Backorders", href: "#" },
      { label: "Expired Auctions", href: "#" },
      { label: "User Auctions", href: "#" },
      { label: "Backorder Auctions", href: "#" },
      { label: "Last Chance Auctions", href: "#" },
      { label: "Expired Closeout", href: "#" },
      { label: "NameClub Beta", href: "#" },
    ],
  },
  {
    heading: "Support",
    links: [
      { label: "Blog", href: "#" },
      { label: "Help Files", href: "#" },
      { label: "Forums", href: "#" },
      { label: "Buying Domains", href: "#" },
      { label: "Selling Domains", href: "#" },
      { label: "Newsletter", href: "#" },
      { label: "Prepay", href: "#" },
      { label: "Payment Options", href: "#" },
      { label: "Report Abuse", href: "#" },
    ],
  },
  {
    heading: "Dynadot",
    links: [
      { label: "About", href: "#" },
      { label: "Contact", href: "#" },
      { label: "Events", href: "#" },
      { label: "Site Map", href: "#" },
      { label: "APP", href: "#" },
      { label: "Refer-a-friend", href: "#" },
      { label: "Affiliate", href: "#" },
    ],
  },
];

export const FOOTER_LEGAL: NavItem[] = [
  { label: "Privacy Policy", href: "#" },
  { label: "Terms of Use", href: "#" },
  { label: "Registrant Educational Information", href: "#" },
  { label: "Registrants Benefits and Responsibilities", href: "#" },
];
