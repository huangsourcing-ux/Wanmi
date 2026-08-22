export interface NavItem {
  label: string;
  href: string;
}

export interface AuctionListing {
  domain: string;
  price: string;
  bids: number;
  /** Countdown label as rendered on the source page, e.g. "14h, 38m". */
  endsIn?: string;
  /**
   * `.ending-soon` variant on the source — recolours the price to #AE1DF9
   * (the default `.not-ending-soon` card uses #0262C7 for both badge and price).
   */
  endingSoon?: boolean;
}

export interface StatItem {
  value: string;
  label: string;
}

export interface FeatureRow {
  title: string;
  body: string;
  cta: string;
  image: string;
  alt: string;
  /** true = image sits on the right of the copy at lg+ */
  imageRight: boolean;
}

export interface AftermarketCard {
  title: string;
  body: string;
  cta: string;
  icon: string;
  alt: string;
}

/**
 * One card in the "Build on Your Domain Names" horizontal accordion.
 * At xl the hovered card is 450px wide and the rest collapse to 225px.
 */
export interface BentoCard {
  title: string;
  body: string;
  cta: string;
  image: string;
  alt: string;
  /** Card surface — a radial gradient fading to white, verbatim from source */
  gradient: string;
  /** Collapsed-state title colour; the dark card uses white */
  titleOnDark?: boolean;
}

export interface WhyBlock {
  title: string;
  body: string;
  cta: string;
  image: string;
  alt: string;
}

export interface ResourceCard {
  title: string;
  body: string;
  cta: string;
}

export interface FaqEntry {
  question: string;
  answer: string[];
}

export interface FooterColumn {
  heading: string;
  links: NavItem[];
}

/** One hover-triggered mega-menu panel under a primary nav item. */
export interface MegaPanel {
  /** Primary nav label that opens this panel */
  label: string;
  /** Lead column heading, 24px/500 */
  title: string;
  /** Optional tagline under the lead heading */
  lead?: string;
  /** Optional promo block in the lead column */
  promo?: { title: string; body: string; cta: string };
  columns: FooterColumn[];
  /** Column width measured on the source: 345px, or 290px for 6-column panels */
  columnWidth: 345 | 290;
}
