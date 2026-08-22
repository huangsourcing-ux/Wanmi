export interface NavItem {
  label: string;
  href: string;
}

export interface FeatureRow {
  title: string;
  body: string;
  cta: string;
  href: string;
  image: string;
  alt: string;
  /** true = image sits on the right of the copy at lg+ */
  imageRight: boolean;
}

export interface WhyBlock {
  title: string;
  body: string;
  cta: string;
  href: string;
  image: string;
  alt: string;
}

export interface ResourceCard {
  title: string;
  body: string;
  cta: string;
  href: string;
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
  /** Route the tagline links to; without it the tagline is plain text */
  leadHref?: string;
  columns: FooterColumn[];
  /** Column width measured on the source: 345px, or 290px for three-column panels */
  columnWidth: 345 | 290;
}
