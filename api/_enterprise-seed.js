// Public-source research. Unknown relationships must not be inferred.
export const SOURCES = {
  "co-program": {
    "title": "Capital One supplier development",
    "url": "https://www.capitalone.com/about/corporate-information/about-our-supplier-development-and-opportunity-program/",
    "reviewedAt": "2026-10-05"
  },
  "co-buy": {
    "title": "Capital One supplier onboarding and invoicing",
    "url": "https://www.capitalone.com/about/corporate-information/details-for-doing-business-with-capital-one/",
    "reviewedAt": "2026-10-05"
  },
  "co-size": {
    "title": "Capital One 2025 Form 10-K",
    "url": "https://www.sec.gov/Archives/edgar/data/927628/000092762826000024/cof-20251231.htm",
    "reviewedAt": "2026-10-05"
  },
  "jp-suppliers": {
    "title": "JPMorganChase suppliers",
    "url": "https://www.jpmorganchase.com/about/suppliers",
    "reviewedAt": "2026-10-05"
  },
  "jp-contingent": {
    "title": "JPMorganChase contingent workers",
    "url": "https://www.jpmorganchase.com/about/suppliers/contingent-workers",
    "reviewedAt": "2026-10-05"
  },
  "jp-register": {
    "title": "JPMorganChase purchasing and invoicing",
    "url": "https://www.jpmorganchase.com/about/suppliers/supplier-invoicing",
    "reviewedAt": "2026-10-05"
  },
  "jp-size": {
    "title": "JPMorganChase 2025 Form 10-K",
    "url": "https://www.sec.gov/Archives/edgar/data/19617/000162828026008131/jpm-20251231.htm",
    "reviewedAt": "2026-10-05"
  },
  "kelly-entry": {
    "title": "KellyOCG supplier resource center",
    "url": "https://www.kellyocg.com/about-us/supplier-community/supplier-resource-center/",
    "reviewedAt": "2026-10-05"
  },
  "kelly-case": {
    "title": "KellyOCG remote and offshore program example",
    "url": "https://www.kellyocg.com/insights/delivering-results-with-a-customised-msp-program-for-a-global-oil-gas-company/",
    "reviewedAt": "2026-10-05"
  },
  "ags-network": {
    "title": "AGS supplier network and Nancy Goff",
    "url": "https://blog.allegisglobalsolutions.com/championing-contingent-workforce-suppliers",
    "reviewedAt": "2026-10-05"
  },
  "ags-suppliers": {
    "title": "AGS 2026 strategic suppliers",
    "url": "https://www.allegisglobalsolutions.com/en/about-us/news-and-events/press-releases/ags-names-2026-strategic-suppliers",
    "reviewedAt": "2026-10-05"
  },
  "ags-entry": {
    "title": "AGS SupplySphere",
    "url": "https://www.allegisglobalsolutions.com/en-au/managed-services/managed-service-provider/supply-chain-management",
    "reviewedAt": "2026-10-05"
  },
  "magnit-entry": {
    "title": "Magnit supplier network",
    "url": "https://aem.magnitglobal.com/us/en/partners/supplier-network.html",
    "reviewedAt": "2026-10-05"
  },
  "magnit-contact": {
    "title": "Magnit supplier relations contact",
    "url": "https://magnitglobal.com/supplier-contact",
    "reviewedAt": "2026-10-05"
  },
  "magnit-leaders": {
    "title": "Magnit leadership",
    "url": "https://magnitglobal.com/about/leadership",
    "reviewedAt": "2026-10-05"
  },
  "magnit-vms": {
    "title": "Magnit Gateway and VMS",
    "url": "https://magnitglobal.com/us/en/company/newsroom/magnit-launches-gateway-for-suppliers.html",
    "reviewedAt": "2026-10-05"
  },
  "pontoon-program": {
    "title": "Pontoon MSP services",
    "url": "https://www.pontoonsolutions.com/services/managed-service-provider",
    "reviewedAt": "2026-10-05"
  },
  "pontoon-case": {
    "title": "Pontoon supplier selection case study",
    "url": "https://www.pontoonsolutions.com/resources/case-study/msp-supply-chain-streamlined-for-maximised-performance",
    "reviewedAt": "2026-10-05"
  },
  "pontoon-services": {
    "title": "Pontoon services procurement",
    "url": "https://www.pontoonsolutions.com/services/managed-service-provider/services-procurement",
    "reviewedAt": "2026-10-05"
  }
};
export const ACCOUNTS = [
  {
    "id": "capital-one",
    "name": "Capital One",
    "lane": "enterprise-direct",
    "domain": "capitalone.com",
    "owner": "Paul",
    "status": "research",
    "researchedAt": "2026-10-05",
    "events": [],
    "contacts": [],
    "facts": [
      {
        "label": "Scale",
        "text": "Approximately 76,300 employees at December 31, 2025.",
        "sourceIds": [
          "co-size"
        ],
        "kind": "documented"
      },
      {
        "label": "Labor buying",
        "text": "Professional services, including temporary labor, are MSP-managed. This does not prove offshore support usage.",
        "sourceIds": [
          "co-program"
        ],
        "kind": "documented"
      },
      {
        "label": "MSP",
        "text": "An MSP is confirmed; its current identity and program scope remain unverified.",
        "sourceIds": [
          "co-program"
        ],
        "kind": "documented"
      },
      {
        "label": "VMS",
        "text": "Beeline is named for consulting/contracting invoices; Coupa handles goods/services. Invoice tooling is not proof of supplier acceptance.",
        "sourceIds": [
          "co-buy"
        ],
        "kind": "documented"
      },
      {
        "label": "Registration",
        "text": "Prospective small-business profile route; onboarding requires a Capital One business contact. Registration does not guarantee a bid.",
        "sourceIds": [
          "co-program",
          "co-buy"
        ],
        "kind": "documented"
      },
      {
        "label": "Prime staffing vendors",
        "text": "Current prime staffing roster not verified.",
        "sourceIds": [],
        "kind": "unknown"
      },
      {
        "label": "Functions",
        "text": "Corporate HR/training, customer operations and professional services are listed purchasing categories.",
        "sourceIds": [
          "co-program"
        ],
        "kind": "documented"
      }
    ],
    "stakeholders": [
      {
        "role": "Chief Procurement Officer",
        "name": "Oz Parvaiz",
        "sourceIds": [
          "co-program"
        ],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "published identity; contact not verified"
      },
      {
        "role": "Supplier Development / Opportunity",
        "name": null,
        "sourceIds": [
          "co-program"
        ],
        "route": "supplieropportunity@capitalone.com",
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Head of Contingent Workforce / FlexForce",
        "name": null,
        "sourceIds": [
          "co-buy"
        ],
        "route": "FlexForce is an existing-supplier support channel, not a sales target.",
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Professional Services Category Manager",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Vendor Management / MSP program owner",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Talent Acquisition / functional operations sponsor",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      }
    ],
    "hypothesis": "Explore recruiting coordination and non-sensitive operations support through the approved workforce channel. Offshore eligibility and access to customer data must be established, not assumed.",
    "entryStrategy": "Ask supplier development which professional-services category and MSP intake route fit Staffify. Establish a category sponsor before pursuing direct onboarding; a qualified prime partnership may be the practical entry.",
    "directOpportunity": "Possible, not qualified. Business sponsorship and procurement approval are still missing.",
    "nextAction": "Prepare a narrow capability brief and request the current professional-services MSP/supplier-intake route.",
    "gaps": [
      "Current MSP identity and staffing prime roster",
      "Three relevant named contacts with verified business addresses",
      "Permitted delivery countries, data controls and service categories",
      "Staffify evidence package and buyer demand"
    ],
    "scoreInputs": {
      "demand": 25,
      "route": 20,
      "stakeholders": 5,
      "fit": 5,
      "readiness": 0
    },
    "opener": "Your supplier information lists professional services and temporary labor under an MSP. I run Staffify, a recruiting and staffing operation. I am trying to understand the right route for offering additional recruiting or delivery capacity, rather than approaching individual hiring teams. Who handles supplier intake for that program?"
  },
  {
    "id": "jpmorgan-chase",
    "name": "JPMorganChase",
    "lane": "enterprise-direct",
    "domain": "jpmorganchase.com",
    "owner": "Paul",
    "status": "research",
    "researchedAt": "2026-10-05",
    "events": [],
    "contacts": [],
    "facts": [
      {
        "label": "Scale",
        "text": "318,512 employees worldwide at December 31, 2025; contractors excluded.",
        "sourceIds": [
          "jp-size"
        ],
        "kind": "documented"
      },
      {
        "label": "Labor buying",
        "text": "Published contingent-worker requirements cover supplier personnel working on-site or accessing sensitive systems remotely.",
        "sourceIds": [
          "jp-contingent"
        ],
        "kind": "documented"
      },
      {
        "label": "Procurement",
        "text": "Supplier partnerships sit with procurement; Jim Connell is identified as CPO.",
        "sourceIds": [
          "jp-suppliers"
        ],
        "kind": "documented"
      },
      {
        "label": "Registration",
        "text": "Supplier setup uses Apex Analytix; SAP Business Network handles purchasing/invoices. Neither is evidence of its workforce VMS.",
        "sourceIds": [
          "jp-register"
        ],
        "kind": "documented"
      },
      {
        "label": "MSP / VMS",
        "text": "Current contingent workforce MSP and VMS not verified.",
        "sourceIds": [],
        "kind": "unknown"
      },
      {
        "label": "Prime staffing vendors",
        "text": "Staffing-specific current prime roster not verified.",
        "sourceIds": [],
        "kind": "unknown"
      }
    ],
    "stakeholders": [
      {
        "role": "Chief Procurement Officer",
        "name": "Jim Connell",
        "sourceIds": [
          "jp-suppliers"
        ],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "published identity; contact not verified"
      },
      {
        "role": "Contingent Workforce Program Head",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Professional Services / Labor Category Manager",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Strategic Sourcing / Vendor Management",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Supplier Development / Diversity",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Talent Acquisition / Operations sponsor",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      }
    ],
    "hypothesis": "Explore a limited recruiting-operations or non-sensitive support scope through an approved prime, after screening and data-access requirements are understood.",
    "entryStrategy": "Map the contingent labor category and supplier minimum controls first. Obtain a program sponsor or approved-prime referral; do not treat the payment-onboarding mailbox as a prospecting channel.",
    "directOpportunity": "Longer path. Published supplier controls are substantial and Staffify fit is not yet qualified.",
    "nextAction": "Identify the contingent labor category owner and document minimum controls against Staffify capabilities.",
    "gaps": [
      "Program owner and three verified relevant contacts",
      "MSP, VMS and staffing-specific primes",
      "Offshore/nearshore policy and acceptable scope",
      "Security and screening readiness"
    ],
    "scoreInputs": {
      "demand": 25,
      "route": 10,
      "stakeholders": 5,
      "fit": 5,
      "readiness": 0
    },
    "opener": "I saw that JPMorganChase has a formal contingent-worker supplier process. Before sending a broad staffing pitch, I would like to understand who evaluates additional recruiting and delivery partners for that program. Is that handled by your contingent labor category team or through an MSP?"
  },
  {
    "id": "kellyocg",
    "name": "KellyOCG",
    "lane": "tier-two",
    "domain": "kellyocg.com",
    "owner": "Paul",
    "status": "research",
    "researchedAt": "2026-10-05",
    "events": [],
    "contacts": [],
    "facts": [
      {
        "label": "Scale / functions",
        "text": "Enterprise MSP program delivery; one published global oil-and-gas example reports 280M spend under management. That is program scope, not company revenue.",
        "sourceIds": [
          "kelly-case"
        ],
        "kind": "documented"
      },
      {
        "label": "Labor model",
        "text": "The case describes evaluating remote/offshore roles and adding suppliers through the MSP program office.",
        "sourceIds": [
          "kelly-case"
        ],
        "kind": "documented"
      },
      {
        "label": "Supplier entry",
        "text": "Prospective suppliers are directed to the Supplier Engagement & Services Team.",
        "sourceIds": [
          "kelly-entry"
        ],
        "kind": "documented"
      },
      {
        "label": "MSP / VMS",
        "text": "KellyOCG is the MSP target; client-specific VMS and open programs remain unverified.",
        "sourceIds": [],
        "kind": "unknown"
      },
      {
        "label": "Existing staffing relationships",
        "text": "Supplier community is documented; no specific client contract is attributed to Staffify or inferred from anonymous cases.",
        "sourceIds": [
          "kelly-entry"
        ],
        "kind": "documented"
      }
    ],
    "stakeholders": [
      {
        "role": "Supplier Engagement & Services",
        "name": null,
        "sourceIds": [
          "kelly-entry"
        ],
        "route": "supplierstrateng@kellyocg.com",
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "AMER supply chain enablement",
        "name": null,
        "sourceIds": [
          "kelly-entry"
        ],
        "route": "Existing-supplier support team; use prospective-supplier intake first.",
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Client program / PMO delivery leader",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Supplier Inclusion program owner",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Recruiting operations / offshore delivery leader",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      }
    ],
    "hypothesis": "A focused recruiting-capacity pilot or offshore/nearshore delivery partnership may fit a program need. Published offshore use is evidence of a model, not an open requisition.",
    "entryStrategy": "Start with the published prospective-supplier team. Offer a specific recruiting/delivery capability profile and ask where program coverage is lacking; request onboarding requirements before promising capacity.",
    "directOpportunity": "Supplier partnership path is published; acceptance and live demand are unknown.",
    "nextAction": "Complete the capability brief, then draft a routing inquiry to the published prospective-supplier team.",
    "gaps": [
      "Named supplier engagement owner and program sponsor",
      "Current geographic and skill gaps",
      "Minimum insurance, references, delivery and screening requirements",
      "Verified contact and Staffify capacity evidence"
    ],
    "scoreInputs": {
      "demand": 25,
      "route": 25,
      "stakeholders": 5,
      "fit": 10,
      "readiness": 0
    },
    "opener": "I found your prospective-supplier resource page and wanted to ask a focused question. Staffify runs a recruiting and staffing operation, and we are exploring where additional offshore or nearshore sourcing and delivery capacity could help an existing workforce program. Is there a particular capability gap your supplier team is reviewing, or a profile we should complete first?"
  },
  {
    "id": "allegis-global-solutions",
    "name": "Allegis Global Solutions",
    "lane": "tier-two",
    "domain": "allegisglobalsolutions.com",
    "owner": "Paul",
    "status": "research",
    "researchedAt": "2026-10-05",
    "events": [],
    "contacts": [],
    "facts": [
      {
        "label": "Scale / reach",
        "text": "2026 strategic suppliers cover North America, EMEA, APAC and India; employee count not established in this review.",
        "sourceIds": [
          "ags-suppliers"
        ],
        "kind": "documented"
      },
      {
        "label": "Supplier model",
        "text": "Supplier Advocacy Network and SupplySphere provide a structured supplier relationship route.",
        "sourceIds": [
          "ags-network",
          "ags-entry"
        ],
        "kind": "documented"
      },
      {
        "label": "Existing staffing relationships",
        "text": "2026 North America list includes Actalent, Apex Systems, Aston Carter and TEKsystems. This is an AGS network relationship, not a Capital One contract claim.",
        "sourceIds": [
          "ags-suppliers"
        ],
        "kind": "documented"
      },
      {
        "label": "MSP / VMS",
        "text": "AGS is the MSP target. Acumen measures supplier performance; a specific client VMS is unverified.",
        "sourceIds": [
          "ags-suppliers"
        ],
        "kind": "documented"
      }
    ],
    "stakeholders": [
      {
        "role": "Global Executive Director, Supplier Relationships",
        "name": "Nancy Goff",
        "sourceIds": [
          "ags-network"
        ],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "published identity; contact not verified"
      },
      {
        "role": "President / executive sponsor",
        "name": "Steve Schumacher",
        "sourceIds": [
          "ags-suppliers"
        ],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "published identity; contact not verified"
      },
      {
        "role": "Regional Supplier Advocacy / SupplySphere owner",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Program delivery leader",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Services procurement / category lead",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Supplier inclusion lead",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      }
    ],
    "hypothesis": "Specialist sourcing or recruiting delivery support under a defined region/role scope, with measurable candidate quality and turnaround.",
    "entryStrategy": "Pursue SupplySphere and a referral to the relevant supplier relationship team. Use a tightly scoped pilot rather than claiming enterprise-scale coverage. Do not cold-email the president as the first entry.",
    "directOpportunity": "Partner access route exists; no open supplier allocation or approved status established.",
    "nextAction": "Build a capability profile matching one region and skill family; identify the appropriate supplier relationship manager.",
    "gaps": [
      "Named operational sponsor and verified business email",
      "Open supplier needs and geography",
      "Staffify references and delivery metrics",
      "Client-specific MSP program requirements"
    ],
    "scoreInputs": {
      "demand": 25,
      "route": 20,
      "stakeholders": 10,
      "fit": 5,
      "readiness": 0
    },
    "opener": "I read about your Supplier Advocacy Network and SupplySphere. I run Staffify, a recruiting and staffing operation, and would like to understand where a specialist sourcing or delivery partner could be useful to your programs. Would your supplier relationships team be the right place to discuss a small, clearly scoped capability?"
  },
  {
    "id": "magnit",
    "name": "Magnit",
    "lane": "tier-two",
    "domain": "magnitglobal.com",
    "owner": "Paul",
    "status": "research",
    "researchedAt": "2026-10-05",
    "events": [],
    "contacts": [],
    "facts": [
      {
        "label": "Scale / model",
        "text": "Global contingent workforce provider with a published supplier network; company headcount not verified.",
        "sourceIds": [
          "magnit-entry"
        ],
        "kind": "documented"
      },
      {
        "label": "Entry criteria",
        "text": "Supplier profile route is published; criteria include MSP performance, candidate quality and compliance.",
        "sourceIds": [
          "magnit-entry"
        ],
        "kind": "documented"
      },
      {
        "label": "MSP / VMS",
        "text": "Magnit runs managed programs and a proprietary VMS. Gateway connects participating suppliers; access is not supplier approval.",
        "sourceIds": [
          "magnit-vms"
        ],
        "kind": "documented"
      },
      {
        "label": "Existing staffing relationships",
        "text": "Supplier network established; specific live client allocations and prime roster not researched to confirmation.",
        "sourceIds": [],
        "kind": "unknown"
      }
    ],
    "stakeholders": [
      {
        "role": "Supplier Relations team",
        "name": null,
        "sourceIds": [
          "magnit-contact"
        ],
        "route": "Published supplier contact form",
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "President, Client Services",
        "name": "Amy Bush",
        "sourceIds": [
          "magnit-leaders"
        ],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "published identity; contact not verified"
      },
      {
        "role": "General Counsel / compliance escalation",
        "name": "Phoebe Vu Cachuela",
        "sourceIds": [
          "magnit-leaders"
        ],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "published identity; contact not verified"
      },
      {
        "role": "Regional supplier manager",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Program delivery / category owner",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      }
    ],
    "hypothesis": "Recruiting/delivery support for a demonstrable program gap. A prior MSP track record may be a barrier; establish whether a small pilot or subcontract route is available.",
    "entryStrategy": "Use Supplier Relations and the supplier company profile. Ask how a newer specialist partner is evaluated and whether a prime-sponsored entry is more appropriate.",
    "directOpportunity": "Published intake; acceptance depends on track record and program demand.",
    "nextAction": "Confirm whether Staffify meets supplier criteria before submitting a company profile.",
    "gaps": [
      "Named supplier relations owner and verified contact",
      "MSP track record requirement versus Staffify evidence",
      "Open program and role demand",
      "Insurance, employment and data handling requirements"
    ],
    "scoreInputs": {
      "demand": 25,
      "route": 25,
      "stakeholders": 5,
      "fit": 5,
      "readiness": 0
    },
    "opener": "I found Magnit\u2019s supplier profile and wanted to check fit before submitting anything. Staffify runs recruiting and staffing delivery, and we are exploring a focused offshore or nearshore partnership. How does your team evaluate a specialist partner, and is there a route through an existing supplier when that is a better fit?"
  },
  {
    "id": "pontoon",
    "name": "Pontoon Solutions",
    "lane": "tier-two",
    "domain": "pontoonsolutions.com",
    "owner": "Paul",
    "status": "research",
    "researchedAt": "2026-10-05",
    "events": [],
    "contacts": [],
    "facts": [
      {
        "label": "Scale",
        "text": "Published MSP offering spans over 60 countries and 600,000 temporary workers annually; these are program figures, not employee headcount.",
        "sourceIds": [
          "pontoon-program"
        ],
        "kind": "documented"
      },
      {
        "label": "Supplier buying",
        "text": "Supplier Partnership Team used an RFP to restructure a financial-services client supplier pool. Client is unnamed.",
        "sourceIds": [
          "pontoon-case"
        ],
        "kind": "documented"
      },
      {
        "label": "Existing staffing relationships",
        "text": "Akkodis is named in the supplier-selection case; no claim is made that the unnamed client is Capital One.",
        "sourceIds": [
          "pontoon-case"
        ],
        "kind": "documented"
      },
      {
        "label": "Procurement",
        "text": "Services include SOW management, vendor selection and category outsourcing.",
        "sourceIds": [
          "pontoon-services"
        ],
        "kind": "documented"
      },
      {
        "label": "MSP / VMS",
        "text": "Pontoon is the MSP target; specific VMS and open supplier intake not verified.",
        "sourceIds": [],
        "kind": "unknown"
      }
    ],
    "stakeholders": [
      {
        "role": "Supplier Partnership Team",
        "name": null,
        "sourceIds": [
          "pontoon-case"
        ],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Regional supplier partnership manager",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "MSP program delivery lead",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Services procurement lead",
        "name": null,
        "sourceIds": [
          "pontoon-services"
        ],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      },
      {
        "role": "Supplier inclusion / development owner",
        "name": null,
        "sourceIds": [],
        "route": null,
        "email": null,
        "emailVerification": "not_verified",
        "status": "role to identify"
      }
    ],
    "hypothesis": "Specialist recruiting or delivery capacity for a defined category; financial-services programs may require stricter screening and local delivery than Staffify can currently evidence.",
    "entryStrategy": "Request routing to Supplier Partnerships via the official MSP/services contact path. Learn the current supplier RFP cycle and role gaps before proposing a pilot.",
    "directOpportunity": "Supplier selection process exists; no current opening confirmed.",
    "nextAction": "Identify the current Supplier Partnerships intake owner and qualification process.",
    "gaps": [
      "Current named supplier team and business addresses",
      "Registration/RFP calendar",
      "Eligible roles and delivery countries",
      "Proof of Staffify program readiness"
    ],
    "scoreInputs": {
      "demand": 25,
      "route": 15,
      "stakeholders": 0,
      "fit": 5,
      "readiness": 0
    },
    "opener": "I read your case study about rebuilding a financial-services supplier pool. Staffify runs a recruiting and staffing operation, and we are exploring whether a specialist sourcing or delivery partner could fill a defined gap. Who on Supplier Partnerships handles new partner capabilities and the next intake cycle?"
  }
];
