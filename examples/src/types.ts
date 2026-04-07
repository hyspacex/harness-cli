export type CertificationTrackId = 'cloud-practitioner' | 'solutions-architect-associate';

export type ServiceCategoryId =
  | 'compute'
  | 'storage'
  | 'database'
  | 'networking'
  | 'security';

export interface CertificationTrack {
  id: CertificationTrackId;
  label: string;
  examLevel: string;
  description: string;
  outcomes: string[];
}

export interface ServiceCategory {
  id: ServiceCategoryId;
  label: string;
  summary: string;
}

export interface BestPracticeNote {
  title: string;
  description: string;
}

export interface Topic {
  id: string;
  name: string;
  shortLabel: string;
  categoryId: ServiceCategoryId;
  overview: string;
  tracks: CertificationTrackId[];
  examSignals: string[];
  useCases: string[];
  tradeOffs: string[];
  operationalNotes: string[];
  pricingNotes: string[];
  bestPracticeNotes: BestPracticeNote[];
  prerequisites: string[];
  relatedTopics: string[];
}
