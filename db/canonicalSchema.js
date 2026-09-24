// The CMA Canonical Schema: the four entities every uploaded dataset file
// type is transformed into, per Brenda Balala's CMA architecture diagrams
// (raw SME data -> Data Mapping & Transformation -> CMA Canonical Schema ->
// Customers / Transactions / Entitlements / Monetization Config).
//
// Each entity lists its canonical fields, whether that field is required
// for a row to freeze as "valid", a plain-language description (shown in
// the mapping-review UI), and a synonym list used by the mapping-suggestion
// engine (services/mapping.js) to guess which source CSV column feeds it.
// Synonyms are written as they'd appear once normalized (lowercased, only
// a-z0-9 kept) — see normalizeHeader() in services/mapping.js.
//
// There is deliberately NO fixed file-name -> entity mapping here anymore.
// An SME owner's uploaded files can be labeled anything at all (see
// sanitizeFileType() in middleware/upload.js) — "accounts.csv",
// "feature_usage.csv", "churn_events.csv" — and none of those names
// determine which of the four canonical entities below a file becomes.
// That choice is made explicitly by the SME owner on the Map & Transform
// screen (routes/dashboard.js), with services/mapping.js's guessEntity()
// only offering a non-authoritative default suggestion to start from.
const CANONICAL_ENTITIES = {
  Customer: {
    label: 'Customers',
    fields: {
      customer_id: {
        required: true,
        type: 'string',
        description: 'Unique identifier for the customer/account/tenant.',
        synonyms: ['customerid', 'customer', 'accountid', 'account', 'projectid', 'project',
          'clientid', 'client', 'userid', 'user', 'subscriberid', 'subscriber', 'tenantid', 'tenant', 'id'],
      },
      name: {
        required: false,
        type: 'string',
        description: 'Customer, account, or business name.',
        synonyms: ['customername', 'accountname', 'businessname', 'company', 'companyname', 'name'],
      },
      email: {
        required: false,
        type: 'string',
        description: 'Contact email address.',
        synonyms: ['email', 'emailaddress', 'contactemail'],
      },
      region: {
        required: false,
        type: 'string',
        description: 'Geographic region, zone, or location.',
        synonyms: ['region', 'regioncode', 'zone', 'location', 'locationtype', 'country', 'area', 'geo'],
      },
      segment: {
        required: false,
        type: 'string',
        description: 'Customer segment, tier, or category.',
        synonyms: ['segment', 'tier', 'category', 'customertype', 'servicetier'],
      },
      account_type: {
        required: false,
        type: 'string',
        description: 'Type or plan of account.',
        synonyms: ['accounttype', 'plantype', 'subscriptiontype', 'producttype'],
      },
      // Optional — added for Diagnostic/Predictive analytics (see
      // claude/canonical-schema-analytics-roadmap.md in the project docs):
      // real tenure and churn signals instead of inferring them from
      // transaction/entitlement activity gaps. All three are optional, so
      // a dataset with none of them keeps transforming exactly as before.
      acquisition_date: {
        required: false,
        type: 'date',
        description: 'When this customer was acquired or signed up.',
        synonyms: ['acquisitiondate', 'signupdate', 'joindate', 'createddate', 'onboardeddate', 'registrationdate'],
      },
      acquisition_channel: {
        required: false,
        type: 'string',
        description: 'How this customer was acquired (channel, source, or campaign).',
        synonyms: ['acquisitionchannel', 'channel', 'source', 'leadsource', 'signupchannel', 'referralsource'],
      },
      churn_date: {
        required: false,
        type: 'date',
        description: 'When this customer churned or cancelled, if applicable.',
        synonyms: ['churndate', 'canceldate', 'cancellationdate', 'terminationdate', 'closeddate'],
      },
    },
  },

  Transaction: {
    label: 'Transactions',
    fields: {
      transaction_id: {
        required: true,
        type: 'string',
        description: 'Unique identifier for this usage/billing record.',
        synonyms: ['transactionid', 'invoiceid', 'orderid', 'resourceid', 'sku', 'ratecode', 'billingid', 'id'],
      },
      customer_id: {
        required: true,
        type: 'string',
        description: 'Which customer/account this transaction belongs to.',
        synonyms: ['customerid', 'customer', 'accountid', 'account', 'projectid', 'project'],
      },
      amount: {
        required: true,
        type: 'number',
        description: 'Total monetary amount for this transaction.',
        // 'costperquantity' deliberately excluded here — it's a per-unit
        // RATE, not a total, and belongs only under unit_price below. A
        // rate column and a total-cost column can legitimately co-exist in
        // the same file (e.g. a cloud cost export with both "Cost per
        // Quantity ($)" and "Rounded Cost ($)"), and amount must never
        // claim the rate column even when scored as a tie against it.
        synonyms: ['amount', 'cost', 'totalcost', 'totalamount', 'roundedcost', 'unroundedcost',
          'price', 'charge', 'totalcostinr'],
        // Used by the transform pipeline when no direct column matches:
        // amount = quantity * unit_price.
        derivable: { from: ['quantity', 'unit_price'], op: 'multiply' },
      },
      currency: {
        required: false,
        type: 'string',
        description: 'Currency the amount is denominated in.',
        synonyms: ['currency', 'curr', 'currencycode'],
      },
      quantity: {
        required: false,
        type: 'number',
        description: 'Usage quantity consumed.',
        synonyms: ['usagequantity', 'quantity', 'qty', 'usageamount', 'units'],
      },
      unit_price: {
        required: false,
        type: 'number',
        description: 'Price per unit of usage.',
        synonyms: ['priceperunit', 'unitprice', 'rate', 'costperquantity', 'pricedescription'],
      },
      timestamp: {
        required: true,
        type: 'date',
        description: 'When the usage/transaction occurred.',
        synonyms: ['usagestartdate', 'usagestarttime', 'transactiondate', 'date', 'timestamp',
          'effectivedate', 'usagedate', 'startdate'],
      },
      product_service: {
        required: false,
        type: 'string',
        description: 'The product, service, or SKU being billed.',
        synonyms: ['servicename', 'service', 'product', 'productfamily', 'offering', 'model'],
      },
      usage_type: {
        required: false,
        type: 'string',
        description: 'The usage/operation type recorded.',
        synonyms: ['usagetype', 'operation', 'usageunit'],
      },
      // Optional — added for Diagnostic analytics: transaction_type is
      // the backbone of a revenue bridge (new/expansion/contraction/churn
      // revenue); config_id lets a transaction be priced against the
      // EXACT MonetizationConfig row that billed it instead of an
      // average across that product's tiers, when the SME's own data
      // traces that link. Both optional — no effect on datasets without them.
      transaction_type: {
        required: false,
        type: 'string',
        description: 'Nature of this transaction (e.g. new, renewal, upgrade, downgrade, refund).',
        synonyms: ['transactiontype', 'type', 'eventtype', 'billingtype', 'chargetype', 'ordertype'],
      },
      config_id: {
        required: false,
        type: 'string',
        description: 'Which Monetization Config row (rate/plan) priced this transaction, if traceable.',
        synonyms: ['configid', 'priceid', 'skuid', 'rateplanid', 'planid', 'pricingid'],
      },
    },
  },

  Entitlement: {
    label: 'Entitlements',
    fields: {
      entitlement_id: {
        required: true,
        type: 'string',
        description: 'Unique identifier for this entitlement/license/subscription.',
        synonyms: ['entitlementid', 'licenseid', 'subscriptionid', 'id'],
      },
      customer_id: {
        required: true,
        type: 'string',
        description: 'Which customer/account holds this entitlement.',
        synonyms: ['customerid', 'customer', 'accountid', 'account'],
      },
      product_service: {
        required: false,
        type: 'string',
        description: 'The product or service this entitlement grants access to.',
        synonyms: ['product', 'service', 'servicename', 'offering'],
      },
      plan: {
        required: false,
        type: 'string',
        description: 'Plan, package, or tier name.',
        synonyms: ['plan', 'tier', 'package', 'planname'],
      },
      start_date: {
        required: false,
        type: 'date',
        description: 'When the entitlement became active.',
        synonyms: ['startdate', 'effectivedate', 'activationdate'],
      },
      end_date: {
        required: false,
        type: 'date',
        description: 'When the entitlement expires or expired.',
        synonyms: ['enddate', 'expirationdate', 'expirydate'],
      },
      status: {
        required: false,
        type: 'string',
        description: 'Current status (active, expired, suspended, etc).',
        synonyms: ['status', 'state'],
      },
      // Optional — added for Diagnostic/Predictive analytics:
      // cancellation_reason is the highest-value single field for
      // root-causing why entitlements end; auto_renew is a strong
      // churn-risk predictor on its own; config_id links this
      // entitlement to the exact price it was signed at. All optional.
      cancellation_reason: {
        required: false,
        type: 'string',
        description: 'Why this entitlement was cancelled or downgraded, if recorded.',
        synonyms: ['cancellationreason', 'cancelreason', 'churnreason', 'closereason', 'terminationreason'],
      },
      auto_renew: {
        required: false,
        type: 'string',
        description: 'Whether this entitlement auto-renews (e.g. yes/no, true/false).',
        synonyms: ['autorenew', 'renewaltype', 'renewalmode', 'isautorenew'],
      },
      config_id: {
        required: false,
        type: 'string',
        description: 'Which Monetization Config row (rate/plan) this entitlement was signed at, if traceable.',
        synonyms: ['configid', 'priceid', 'planid', 'rateplanid', 'skuid'],
      },
    },
  },

  MonetizationConfig: {
    label: 'Monetization Config',
    fields: {
      config_id: {
        required: true,
        type: 'string',
        description: 'Unique identifier for this pricing/rate configuration.',
        synonyms: ['configid', 'ratecode', 'sku', 'offertermcode', 'id'],
      },
      model_type: {
        required: false,
        type: 'string',
        description: 'Pricing/revenue model type (e.g. pay-per-use, subscription).',
        synonyms: ['modeltype', 'pricingmodel', 'termtype', 'policytype'],
      },
      product_service: {
        required: false,
        type: 'string',
        description: 'The product or service this configuration prices.',
        synonyms: ['product', 'service', 'servicename', 'productfamily'],
      },
      price: {
        required: true,
        type: 'number',
        description: 'The configured price.',
        synonyms: ['price', 'priceperunit', 'rate', 'unitprice'],
      },
      unit: {
        required: false,
        type: 'string',
        description: 'The unit the price applies to.',
        synonyms: ['unit', 'usageunit', 'uom'],
      },
      tier: {
        required: false,
        type: 'string',
        description: 'Pricing tier or usage range this config applies to.',
        synonyms: ['tier', 'range', 'startingrange', 'endingrange'],
      },
      currency: {
        required: false,
        type: 'string',
        description: 'Currency the price is denominated in.',
        synonyms: ['currency', 'curr', 'currencycode'],
      },
      // Optional — the highest-leverage single addition for Diagnostic/
      // Prescriptive analytics (see claude/canonical-schema-analytics-
      // roadmap.md): without a real effective-date range, a price is only
      // ever a snapshot (whatever the latest mapping_version says), never
      // a history — so "what was this product's configured price when
      // THIS transaction happened" can't be reconstructed, which caps how
      // precise Reconciliation, price-change diagnostics, and elasticity
      // modeling can ever be. Both optional — a dataset without them
      // keeps working exactly as it does today (price treated as
      // always-current, as now).
      effective_from: {
        required: false,
        type: 'date',
        description: 'When this configured price became effective.',
        synonyms: ['effectivefrom', 'effectivedate', 'startdate', 'validfrom', 'begindate'],
      },
      effective_to: {
        required: false,
        type: 'date',
        description: 'When this configured price stopped being effective, if it has ended.',
        synonyms: ['effectiveto', 'enddate', 'validto', 'expirydate', 'expirationdate'],
      },
    },
  },
};

module.exports = { CANONICAL_ENTITIES };
