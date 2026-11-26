export interface GuardrailConfig {
  isAutopilotEnabled: boolean;
  isOrganicAutoPostEnabled?: boolean;
  dailySpendCap: number;
  targetCpa: number;
  minRoas: number;
  evaluationWindowHours: number;
}

export type CreativeStatus =
  | "generated"
  | "needs_review"
  | "pending_approval"
  | "live"
  | "killed";

export interface CreativeMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  cpa: number;
  roas: number;
}

export interface CreativeDocument {
  id?: string;
  campaignId: string;
  metaAdId: string | null;
  metaCreativeId?: string;
  hook: string;
  primaryText: string;
  headline: string;
  imagePrompt: string;
  angle: string;
  criticScore: number;
  criticFeedback: string[];
  status: CreativeStatus;
  mediaStoragePath?: string;
  compositedStoragePath?: string;
  mediaUrl?: string;
  videoStoragePath?: string;
  videoUrl?: string;
  mediaType?: "image" | "video";
  aspectRatio?: string;
  isComposited?: boolean;
  isOrganicPosted: boolean;
  metrics: CreativeMetrics;
}

export interface MetaAdAccount {
  id: string;
  name: string;
  currency?: string;
  account_status?: number;
}

export interface MetaPage {
  id: string;
  name: string;
}

export interface BrandDnaDocument {
  brandId?: string;
  productUrl: string;
  brandName: string;
  brandColors: string[];
  corePainPoints: string[];
  uniqueSellingPoints: string[];
  extractedReviews: string;
  recommendedTargetAudience: string;
}

export interface GenerateCreativeRequest {
  campaignId: string;
  productName: string;
  productDescription: string;
  targetAudience?: string;
  winningCompetitorAd?: string;
}

export interface GenerateCreativeResponse extends CreativeDocument {
  creativeId: string;
}

export interface PublishMetaAdRequest {
  creativeId: string;
  campaignName?: string;
  dailyBudget: number;
  targetCountry: string;
  landingPageUrl: string;
  facebookPageId: string;
  pixelId?: string;
}

export interface PublishMetaAdResponse {
  success: boolean;
  metaCampaignId: string;
  metaAdSetId: string;
  metaAdId: string;
  status: "ACTIVE" | "PAUSED";
}
