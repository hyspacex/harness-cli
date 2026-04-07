import {
  CertificationTrack,
  CertificationTrackId,
  ServiceCategory,
  ServiceCategoryId,
  Topic,
} from '../types.js';

export const certificationTracks: CertificationTrack[] = [
  {
    id: 'cloud-practitioner',
    label: 'Cloud Practitioner',
    examLevel: 'Foundational',
    description:
      'Build fluency in core AWS services, the shared responsibility model, and common cloud economics decisions.',
    outcomes: [
      'Recognize the primary AWS service for common storage, compute, networking, and identity scenarios.',
      'Explain AWS pricing basics and where managed services reduce operational overhead.',
      'Use the right AWS vocabulary for security, resilience, and cost optimization trade-offs.',
    ],
  },
  {
    id: 'solutions-architect-associate',
    label: 'Solutions Architect Associate',
    examLevel: 'Associate',
    description:
      'Choose AWS services intentionally, reason through architectural trade-offs, and map designs to best practices.',
    outcomes: [
      'Compare service combinations such as Lambda plus API Gateway versus EC2-based application stacks.',
      'Apply AWS Well-Architected Framework guidance to reliability, security, and cost trade-offs.',
      'Sequence foundational topics so identity, networking, and storage decisions support later architectures.',
    ],
  },
];

export const serviceCategories: ServiceCategory[] = [
  {
    id: 'compute',
    label: 'Compute',
    summary: 'Execution environments, scaling models, and operational ownership for workloads.',
  },
  {
    id: 'storage',
    label: 'Storage',
    summary: 'Persistent data services for objects, files, and block-based workloads.',
  },
  {
    id: 'database',
    label: 'Database',
    summary: 'Relational and NoSQL services with different consistency, scaling, and admin trade-offs.',
  },
  {
    id: 'networking',
    label: 'Networking & Edge',
    summary: 'Connectivity, routing, content delivery, and service exposure across AWS environments.',
  },
  {
    id: 'security',
    label: 'Security & Identity',
    summary: 'Access control, federation, and the controls that shape secure AWS architectures.',
  },
];

export const topics: Topic[] = [
  {
    id: 'ec2',
    name: 'Amazon EC2',
    shortLabel: 'EC2',
    categoryId: 'compute',
    tracks: ['cloud-practitioner', 'solutions-architect-associate'],
    overview:
      'Amazon EC2 provides resizable virtual machines when you need operating-system level control, custom runtimes, or steady compute capacity that does not fit a pure serverless model.',
    examSignals: [
      'Know when EC2 is the better fit than Lambda for long-running or heavily customized workloads.',
      'Connect EC2 decisions to security groups, Auto Scaling, and storage choices such as EBS.',
    ],
    useCases: [
      'Amazon EC2 fits workloads that require custom operating system packages, daemon processes, or third-party agents that are difficult to package into managed runtimes.',
      'It is also a common choice for lift-and-shift migrations where an application already expects a server, stable host identity, or local disk attached to the instance.',
    ],
    tradeOffs: [
      'EC2 gives you flexibility, but you also inherit more patching, capacity planning, and instance lifecycle management than with Lambda or fully managed containers.',
      'Architects must model scaling and recovery behavior explicitly because idle instances still cost money and poorly sized fleets can become either a performance bottleneck or unnecessary spend.',
    ],
    operationalNotes: [
      'Production EC2 designs usually pair launch templates, Auto Scaling groups, and CloudWatch metrics so capacity changes happen predictably instead of by manual intervention.',
      'Instance profile design matters because application permissions should come from IAM roles rather than long-lived keys stored on the host.',
    ],
    pricingNotes: [
      'On-Demand pricing is simple for bursty experimentation, while Savings Plans or Reserved Instances reduce steady-state costs when you can predict baseline usage.',
      'Data transfer, EBS throughput, and oversized instances often become material cost drivers even when the hourly instance price looks acceptable in isolation.',
    ],
    bestPracticeNotes: [
      {
        title: 'AWS Well-Architected Framework',
        description:
          'The AWS Well-Architected Framework is relevant to EC2 because compute sizing, Auto Scaling, and patching choices directly affect operational excellence, reliability, and cost optimization.',
      },
    ],
    prerequisites: ['iam', 'vpc'],
    relatedTopics: ['ebs', 'lambda'],
  },
  {
    id: 'lambda',
    name: 'AWS Lambda',
    shortLabel: 'Lambda',
    categoryId: 'compute',
    tracks: ['cloud-practitioner', 'solutions-architect-associate'],
    overview:
      'AWS Lambda runs code in response to events without managing servers, which makes it central to AWS certification scenarios about serverless design and elastic scaling.',
    examSignals: [
      'Compare Lambda with EC2 when the exam asks about unpredictable demand, event-driven systems, or reduced operational overhead.',
      'Remember that cold starts, execution duration limits, and downstream service design all shape Lambda suitability.',
    ],
    useCases: [
      'Lambda is a strong choice for event-driven APIs, stream processing, and automation tasks that only need compute when a trigger such as an S3 upload or API request occurs.',
      'It also works well for glue code between AWS services because you can connect queues, notifications, and data processing jobs without maintaining a server fleet.',
    ],
    tradeOffs: [
      'Lambda reduces infrastructure management, but it introduces execution time limits, packaging constraints, and cold-start considerations that matter for latency-sensitive applications.',
      'Stateful or continuously running workloads can become awkward on Lambda because the service expects short-lived, stateless functions rather than long-running processes.',
    ],
    operationalNotes: [
      'Teams should monitor concurrency, timeout settings, and retry semantics because misconfigured handlers can amplify errors across event sources quickly.',
      'Dependency size and runtime selection are operational concerns since large deployment packages and VPC-attached functions can increase cold-start overhead.',
    ],
    pricingNotes: [
      'Lambda pricing is driven by request count and compute duration, so small but frequent invocations can cost more than expected when an architecture becomes chatty.',
      'Provisioned Concurrency improves startup predictability for interactive flows, but it adds a standing cost that should be justified by user-facing latency requirements.',
    ],
    bestPracticeNotes: [
      {
        title: 'AWS Well-Architected Framework',
        description:
          'Within the AWS Well-Architected Framework, Lambda supports operational excellence by reducing server management, but good architectures still need observability, failure handling, and cost-aware event design.',
      },
    ],
    prerequisites: ['iam'],
    relatedTopics: ['dynamodb', 'ec2'],
  },
  {
    id: 's3',
    name: 'Amazon S3',
    shortLabel: 'S3',
    categoryId: 'storage',
    tracks: ['cloud-practitioner', 'solutions-architect-associate'],
    overview:
      'Amazon S3 is AWS object storage and appears constantly in certification scenarios that involve static content, backups, analytics data lakes, and durable low-management storage.',
    examSignals: [
      'Distinguish S3 from EBS and relational databases by storage model, access pattern, and durability characteristics.',
      'Recognize how versioning, lifecycle policies, and storage classes change resilience and cost posture.',
    ],
    useCases: [
      'Amazon S3 is commonly used for static website assets, media libraries, backups, and centralized log archives because it scales without pre-provisioning capacity.',
      'It is also the default storage layer for many analytics and machine learning pipelines where many services need durable object access at different times.',
    ],
    tradeOffs: [
      'S3 is object storage, so workloads that need POSIX-style file semantics, low-latency block access, or direct in-place edits should use another storage pattern.',
      'Designers must account for request patterns, lifecycle transitions, and data transfer because the cheapest storage tier is not always the cheapest end-to-end architecture.',
    ],
    operationalNotes: [
      'Bucket policies, versioning, access logs, and lifecycle rules are operational controls that influence recoverability, governance, and incident response quality.',
      'Public access settings should be explicit from day one because accidental exposure often comes from policy drift or misunderstood ACL behavior.',
    ],
    pricingNotes: [
      'Storage class selection matters because Standard, Intelligent-Tiering, and Glacier classes balance retrieval speed and monitoring overhead against lower per-gigabyte cost.',
      'PUT requests, replication, and internet egress can dominate the bill when a workload serves lots of small objects or distributes content globally.',
    ],
    bestPracticeNotes: [
      {
        title: 'Shared Responsibility Model',
        description:
          'The Shared Responsibility Model applies directly to Amazon S3: AWS secures the underlying storage service, while you remain responsible for bucket policies, encryption choices, and who can read your data.',
      },
      {
        title: 'AWS Well-Architected Framework',
        description:
          'The AWS Well-Architected Framework is visible in S3 design because lifecycle rules, backup posture, and encryption defaults affect the security, reliability, and cost pillars at the same time.',
      },
    ],
    prerequisites: ['iam'],
    relatedTopics: ['cloudfront', 'ebs'],
  },
  {
    id: 'ebs',
    name: 'Amazon EBS',
    shortLabel: 'EBS',
    categoryId: 'storage',
    tracks: ['solutions-architect-associate'],
    overview:
      'Amazon EBS provides persistent block storage for EC2 instances and is essential when a workload needs low-latency attached volumes rather than object storage.',
    examSignals: [
      'Know that EBS is tied to EC2 and Availability Zone placement, unlike S3 which is regional object storage.',
      'Understand snapshot usage, performance tiers, and the operational coupling between an instance and its attached volumes.',
    ],
    useCases: [
      'Amazon EBS is appropriate for boot volumes, transactional applications, and databases running on EC2 that need predictable low-latency block storage.',
      'It also supports workloads that need point-in-time snapshots for backup or migration without redesigning the application around object APIs.',
    ],
    tradeOffs: [
      'EBS is powerful for block storage, but it is attached to EC2 and therefore inherits more infrastructure management than fully managed data services.',
      'Architectures must respect Availability Zone boundaries because moving a workload across zones may require snapshots or replication planning rather than simple live reattachment.',
    ],
    operationalNotes: [
      'Snapshot policies, encryption, and IOPS selection are operational decisions that affect recovery times and the application performance seen by end users.',
      'Volume type matters because gp3, io2, and throughput-optimized options are tuned for different latency and throughput expectations.',
    ],
    pricingNotes: [
      'EBS pricing includes allocated storage and, for some volume classes, provisioned IOPS or throughput, so over-sizing for safety can produce avoidable spend.',
      'Frequent snapshots are operationally useful, but they also add incremental storage cost that should be measured alongside EC2 and data transfer charges.',
    ],
    bestPracticeNotes: [
      {
        title: 'AWS Well-Architected Framework',
        description:
          'From an AWS Well-Architected Framework perspective, EBS choices influence reliability and performance efficiency because snapshot strategy and volume sizing determine recovery behavior and steady-state throughput.',
      },
    ],
    prerequisites: ['ec2'],
    relatedTopics: ['s3', 'rds'],
  },
  {
    id: 'rds',
    name: 'Amazon RDS',
    shortLabel: 'RDS',
    categoryId: 'database',
    tracks: ['cloud-practitioner', 'solutions-architect-associate'],
    overview:
      'Amazon RDS is the managed relational database service for AWS workloads that still need SQL, transactional consistency, and familiar database engines without self-managing every server task.',
    examSignals: [
      'Choose RDS when the scenario needs joins, ACID transactions, or managed backups instead of a schemaless key-value store.',
      'Know the trade-off between operational simplicity and the need to design around instance class, storage, and Multi-AZ behavior.',
    ],
    useCases: [
      'Amazon RDS fits web applications, line-of-business systems, and reporting tools that depend on relational schemas, transactions, and established SQL tooling.',
      'It is also a common answer when the exam asks for managed backups, automatic patching windows, and a database that feels familiar to teams coming from on-premises environments.',
    ],
    tradeOffs: [
      'RDS reduces administrative toil compared with self-managed databases on EC2, but you still choose engine versions, instance classes, and maintenance timing.',
      'Relational scaling patterns can become complex under very high write throughput or globally distributed access, which is where DynamoDB or Aurora design decisions often enter the comparison.',
    ],
    operationalNotes: [
      'Backups, parameter groups, Multi-AZ failover, and read replicas are operational settings that determine whether the database behaves well during peak load or incidents.',
      'Security groups and secret rotation matter because database connectivity problems often come from networking or credential practices rather than the engine itself.',
    ],
    pricingNotes: [
      'RDS pricing combines compute, storage, backup retention, and optional IOPS, so an undersized cluster that needs frequent scaling may become more expensive than a better-fitted instance choice.',
      'Multi-AZ deployments improve resilience, but they also raise cost because you are paying for standby capacity and replicated storage behavior.',
    ],
    bestPracticeNotes: [
      {
        title: 'AWS Well-Architected Framework',
        description:
          'The AWS Well-Architected Framework matters for RDS because backup posture, Multi-AZ design, and secret management directly affect reliability, security, and operational excellence.',
      },
    ],
    prerequisites: ['vpc', 'iam'],
    relatedTopics: ['dynamodb', 'ec2'],
  },
  {
    id: 'dynamodb',
    name: 'Amazon DynamoDB',
    shortLabel: 'DynamoDB',
    categoryId: 'database',
    tracks: ['cloud-practitioner', 'solutions-architect-associate'],
    overview:
      'Amazon DynamoDB is AWS managed NoSQL storage for high-scale, low-latency key-value and document access patterns where server management and relational joins are not the primary goal.',
    examSignals: [
      'Know when DynamoDB is preferable to RDS because of predictable key access, elastic scale, or serverless integration.',
      'Expect exam questions to probe partition-key design, on-demand pricing, and eventually consistent access patterns.',
    ],
    useCases: [
      'Amazon DynamoDB works well for session stores, gaming state, IoT event indexes, and shopping carts that need fast access by a well-designed key.',
      'It is also a strong match for serverless systems because it integrates cleanly with Lambda and scales without instance management or patching windows.',
    ],
    tradeOffs: [
      'DynamoDB can deliver excellent scale, but the data model must be designed around access patterns up front because ad hoc joins and relational queries are not its strength.',
      'Hot partitions, inefficient scan operations, and poorly chosen keys can turn a theoretically scalable design into a performance and cost problem quickly.',
    ],
    operationalNotes: [
      'Capacity mode, auto scaling, TTL settings, and stream consumers should be chosen deliberately because each one changes behavior under burst traffic or asynchronous processing.',
      'Architects need to think about item size, partition distribution, and retry patterns because operational issues are often schema and traffic-shape issues rather than infrastructure failures.',
    ],
    pricingNotes: [
      'On-demand pricing is convenient for uncertain traffic, but predictable workloads can cost less on provisioned capacity with autoscaling configured correctly.',
      'Global tables, backups, and frequent reads of large items all add cost, so a lean key design often improves both performance and budget control.',
    ],
    bestPracticeNotes: [
      {
        title: 'AWS Well-Architected Framework',
        description:
          'In the AWS Well-Architected Framework, DynamoDB design ties performance efficiency and cost optimization together because access-pattern design affects latency, scaling, and spend all at once.',
      },
    ],
    prerequisites: ['iam'],
    relatedTopics: ['lambda', 'rds'],
  },
  {
    id: 'vpc',
    name: 'Amazon VPC',
    shortLabel: 'VPC',
    categoryId: 'networking',
    tracks: ['cloud-practitioner', 'solutions-architect-associate'],
    overview:
      'Amazon VPC is the network boundary for many AWS architectures and forms the foundation for private subnets, routing, and security segmentation decisions across the certification tracks.',
    examSignals: [
      'Expect to reason about public versus private subnets, route tables, internet gateways, and where services should or should not be internet-facing.',
      'Know that later service decisions often inherit the network posture defined in the VPC.',
    ],
    useCases: [
      'Amazon VPC is used to isolate application tiers, keep databases off the public internet, and define the routing rules that control how traffic reaches workloads.',
      'It also supports hybrid connectivity patterns where AWS resources need to communicate with on-premises networks or multiple AWS accounts in a controlled way.',
    ],
    tradeOffs: [
      'VPC networking offers precise control, but that control increases design complexity because subnets, NAT, gateways, and security boundaries must align correctly.',
      'Poor network planning can slow delivery because connectivity failures are often harder to diagnose than simple application bugs and may require changes across multiple AWS services.',
    ],
    operationalNotes: [
      'Subnet placement, route tables, and security groups should be documented carefully because small misconfigurations can break database connectivity, patching flows, or internet egress.',
      'Architects should separate public entry points from private application and data layers so incident response and change management remain understandable over time.',
    ],
    pricingNotes: [
      'The VPC construct itself is not usually the main cost driver, but NAT gateways, inter-AZ traffic, and managed egress patterns can become expensive in chatty architectures.',
      'Designs that push large volumes of data through unnecessary network hops often pay both a cost penalty and a latency penalty.',
    ],
    bestPracticeNotes: [
      {
        title: 'AWS Well-Architected Framework',
        description:
          'The AWS Well-Architected Framework shows up in VPC design because secure segmentation, resilient routing, and minimized egress paths affect the security, reliability, and cost pillars together.',
      },
      {
        title: 'Shared Responsibility Model',
        description:
          'Under the Shared Responsibility Model, AWS secures the global networking infrastructure, while you are responsible for subnet design, route intent, and which workloads are exposed publicly.',
      },
    ],
    prerequisites: [],
    relatedTopics: ['iam', 'cloudfront', 'rds'],
  },
  {
    id: 'cloudfront',
    name: 'Amazon CloudFront',
    shortLabel: 'CloudFront',
    categoryId: 'networking',
    tracks: ['solutions-architect-associate'],
    overview:
      'Amazon CloudFront is AWS content delivery and edge caching, used when architectures need lower latency, origin protection, or globally distributed delivery of web assets and APIs.',
    examSignals: [
      'Know when CloudFront sits in front of S3, custom origins, or APIs to reduce latency and offload origin traffic.',
      'Expect questions about cache behavior, signed URLs, and the trade-off between freshness and performance.',
    ],
    useCases: [
      'Amazon CloudFront is ideal for global delivery of static websites, media downloads, and application assets because edge caching reduces load on the origin.',
      'It can also front APIs and dynamic applications when you need TLS termination, basic origin shielding, or regional acceleration for distributed users.',
    ],
    tradeOffs: [
      'CloudFront improves latency and protects origins, but caching rules, invalidations, and header forwarding choices can complicate application behavior.',
      'Designers must balance freshness against performance because over-aggressive caching can serve stale content while low cacheability can reduce the service’s value.',
    ],
    operationalNotes: [
      'Cache policies, origin failover settings, and observability through logs or metrics should be reviewed regularly because edge behavior becomes part of the application path.',
      'Security controls such as signed URLs, origin access control, and WAF integration matter when CloudFront fronts private assets or public internet traffic.',
    ],
    pricingNotes: [
      'CloudFront pricing depends on request count, geographic data transfer, and optional invalidation volume, so a globally distributed audience changes the cost profile materially.',
      'The service can lower total origin cost, but only if cache hit ratios are high enough to offset its own delivery charges.',
    ],
    bestPracticeNotes: [
      {
        title: 'AWS Well-Architected Framework',
        description:
          'Within the AWS Well-Architected Framework, CloudFront improves performance efficiency and reliability when you use caching and origin protection intentionally rather than as a generic acceleration layer.',
      },
    ],
    prerequisites: ['s3', 'vpc'],
    relatedTopics: ['s3', 'lambda'],
  },
  {
    id: 'iam',
    name: 'AWS Identity and Access Management (IAM)',
    shortLabel: 'IAM',
    categoryId: 'security',
    tracks: ['cloud-practitioner', 'solutions-architect-associate'],
    overview:
      'AWS Identity and Access Management governs who can do what in AWS and is a prerequisite concept for almost every architecture question involving least privilege, service roles, or account security.',
    examSignals: [
      'Understand users, groups, roles, and policies well enough to reason about least privilege and cross-service access.',
      'Connect IAM decisions to other services instead of treating identity as an isolated security concept.',
    ],
    useCases: [
      'IAM is used to grant developers, applications, and AWS services the exact permissions they need to access resources without sharing static credentials broadly.',
      'It is also the service that enables safe automation because EC2 instances, Lambda functions, and CI systems can assume roles instead of storing long-lived keys.',
    ],
    tradeOffs: [
      'IAM is central to security, but large policy estates can become difficult to audit when teams duplicate permissions or rely on overly broad wildcard access.',
      'The service is powerful enough that small mistakes can have account-wide consequences, so permission boundaries and review practices matter as much as initial setup.',
    ],
    operationalNotes: [
      'Role naming, policy versioning, and federation setup should be managed intentionally because identity sprawl slows incident response and permission troubleshooting.',
      'Access Analyzer, CloudTrail, and MFA requirements are operational controls that make IAM changes visible and reduce the blast radius of compromised credentials.',
    ],
    pricingNotes: [
      'IAM itself has no standalone usage charge for most core features, but the security incidents caused by poor permission design can be far more expensive than the time invested in policy hygiene.',
      'Related services such as CloudTrail log retention or external identity tooling may add indirect cost, which is why architects should separate free control-plane assumptions from the operating model around them.',
    ],
    bestPracticeNotes: [
      {
        title: 'Shared Responsibility Model',
        description:
          'The Shared Responsibility Model is explicit in IAM because AWS secures the identity service platform, while you are responsible for least-privilege policies, MFA adoption, and credential lifecycle discipline.',
      },
      {
        title: 'AWS Well-Architected Framework',
        description:
          'The AWS Well-Architected Framework reinforces IAM fundamentals because strong identity boundaries improve security, operational governance, and traceability across every workload.',
      },
    ],
    prerequisites: [],
    relatedTopics: ['cognito', 's3', 'lambda'],
  },
  {
    id: 'cognito',
    name: 'Amazon Cognito',
    shortLabel: 'Cognito',
    categoryId: 'security',
    tracks: ['solutions-architect-associate'],
    overview:
      'Amazon Cognito handles end-user sign-up, sign-in, and token management for applications that need customer identity rather than only administrative AWS account access.',
    examSignals: [
      'Differentiate Cognito user identity from IAM administrative identity and know when each belongs in an architecture.',
      'Watch for scenarios about web and mobile authentication, federation, or token issuance to downstream APIs.',
    ],
    useCases: [
      'Amazon Cognito is designed for consumer-facing applications that need user registration, login, password recovery, and identity federation with social or enterprise providers.',
      'It also helps when API-driven applications need standards-based tokens that front-end clients can use to call backend services securely.',
    ],
    tradeOffs: [
      'Cognito reduces the need to build an identity store from scratch, but custom sign-in journeys and complex federation rules can still require careful application integration.',
      'Teams must separate Cognito’s purpose from IAM because using the wrong service for end-user access versus AWS resource administration leads to brittle designs and confusing permissions.',
    ],
    operationalNotes: [
      'Token lifetimes, hosted UI configuration, and integration with API authorization flows should be reviewed early because identity coupling is difficult to unwind later in a product lifecycle.',
      'Federation choices, user-pool triggers, and recovery flows need clear ownership because identity incidents affect both security posture and customer experience directly.',
    ],
    pricingNotes: [
      'Cognito pricing often scales with monthly active users and advanced security options, so growth in consumer traffic changes the economics differently from infrastructure-priced services.',
      'The service can still be cost-effective because it replaces the operational burden of building account lifecycle, password reset, and federation systems yourself.',
    ],
    bestPracticeNotes: [
      {
        title: 'Shared Responsibility Model',
        description:
          'The Shared Responsibility Model still applies to Cognito because AWS operates the managed identity platform, while you are responsible for app client settings, token handling, and the user journeys that expose authentication data.',
      },
    ],
    prerequisites: ['iam'],
    relatedTopics: ['lambda', 'vpc'],
  },
];

export const topicMap = Object.fromEntries(topics.map((topic) => [topic.id, topic])) as Record<
  string,
  Topic
>;

export function getTopic(topicId: string): Topic {
  return topicMap[topicId];
}

export function getCategory(categoryId: ServiceCategoryId): ServiceCategory {
  const category = serviceCategories.find((item) => item.id === categoryId);

  if (!category) {
    throw new Error(`Unknown category: ${categoryId}`);
  }

  return category;
}

export function getTopicsForTrack(trackId: CertificationTrackId, categoryId?: ServiceCategoryId): Topic[] {
  return topics.filter((topic) => {
    const trackMatch = topic.tracks.includes(trackId);
    const categoryMatch = categoryId ? topic.categoryId === categoryId : true;

    return trackMatch && categoryMatch;
  });
}
