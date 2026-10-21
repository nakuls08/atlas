/**
 * Writes examples/ecommerce/registry: a full e-commerce architecture with real names and flows
 * (checkout, payments, fulfilment, returns, marketplace, data), described compactly below.
 *
 *   tsx scripts/gen-ecommerce.ts
 *
 * Service spec:
 *   api      'Name|STYLE|audience[|tag[|deprecated]]', first one is the service's default API
 *   calls    service key (its first API), 'key#n' (its n-th API), 'ext:id', or 'svc:key!gap reason'
 *   pub/sub  event names; the first service to publish an event owns the topic
 *   store    datastore technology (owned, `<key>-db`); reads: other services' datastores
 *   chanOut  [name, technology, ext]: this service drops files for a partner
 *   chanIn   [name, technology, ext]: a partner drops files for this service
 *   extIn    externals calling this service: 'ext' (first API) or 'ext@n'
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';

interface S {
  key: string;
  api?: string | string[];
  calls?: string[];
  pub?: string[];
  sub?: string[];
  store?: string;
  reads?: string[];
  system?: string;
  role?: 'platform';
  runtime?: string;
  status?: 'planned' | 'deprecated';
  disputed?: string;
  chanOut?: [string, string, string];
  chanIn?: [string, string, string];
  extIn?: string[];
  tags?: string[];
}
interface Dom {
  id: string;
  name: string;
  team: string;
  reviewed?: string;
  systems?: Record<string, string>;
  services: S[];
}
interface Dept {
  id: string;
  name: string;
  head: string;
  domains: Dom[];
}

const DEPTS: Dept[] = [
  {
    id: 'digital',
    name: 'Digital Experience',
    head: 'amara',
    domains: [
      {
        id: 'storefront',
        name: 'Storefront',
        team: 'team-web',
        services: [
          { key: 'web-storefront', runtime: 'next.js', api: 'Storefront Web|REST|public', calls: ['storefront-bff', 'cms-delivery', 'feature-flags', 'event-collector'] },
          {
            key: 'storefront-bff',
            runtime: 'node',
            api: 'Storefront GraphQL|GraphQL|public',
            calls: ['catalog-read', 'search-service', 'pricing', 'cart', 'recommendations', 'customer-profile', 'reviews-read', 'promotions-eval', 'availability', 'delivery-promise', 'loyalty', 'checkout'],
          },
          { key: 'mobile-bff', runtime: 'kotlin', api: 'Mobile API|REST|public', calls: ['catalog-read', 'search-service', 'cart', 'checkout', 'order-service#1', 'orders-read', 'customer-profile', 'loyalty', 'push-service', 'feature-flags'] },
          { key: 'seo-renderer', api: 'Prerender API|REST|internal', calls: ['web-storefront'], store: 'redis' },
        ],
      },
      {
        id: 'search',
        name: 'Search',
        team: 'team-search',
        services: [
          { key: 'search-service', api: 'Search API|REST|internal', calls: ['query-understanding', 'autocomplete', 'merchandising-rules'], reads: ['search-indexer'] },
          { key: 'search-indexer', sub: ['product.updated', 'price.changed', 'inventory.changed', 'review.published'], store: 'elasticsearch' },
          { key: 'query-understanding', api: 'Query NLU API|gRPC|internal', calls: ['model-serving'] },
          { key: 'autocomplete', api: 'Autocomplete API|REST|internal', store: 'redis' },
          { key: 'merchandising-rules', api: 'Merchandising API|REST|internal', store: 'postgres' },
        ],
      },
      {
        id: 'personalization',
        name: 'Personalization',
        team: 'team-reco',
        services: [
          { key: 'recommendations', api: 'Recommendations API|gRPC|internal', calls: ['feature-store', 'model-serving'], store: 'redis' },
          { key: 'reco-trainer', sub: ['order.placed', 'product.viewed'], calls: ['ext:snowflake'], store: 's3' },
          { key: 'experimentation', api: 'Experiments API|REST|internal', store: 'postgres' },
        ],
      },
      {
        id: 'content',
        name: 'Content',
        team: 'team-content',
        services: [
          { key: 'cms-delivery', api: 'Content API|GraphQL|public', sub: ['content.published'], store: 'postgres' },
          { key: 'cms-studio', api: 'CMS Studio API|REST|internal', pub: ['content.published'], calls: ['media-service'] },
          { key: 'media-service', api: 'Media API|REST|internal', calls: ['ext:cloudinary'], store: 's3' },
        ],
      },
    ],
  },
  {
    id: 'commerce',
    name: 'Commerce',
    head: 'jonas',
    domains: [
      {
        id: 'catalog',
        name: 'Catalog',
        team: 'team-catalog',
        systems: { pim: 'Product information' },
        services: [
          { key: 'product-service', system: 'pim', api: ['Product API|REST|internal', 'Product Admin API|REST|internal'], pub: ['product.updated'], sub: ['listing.published'], store: 'postgres' },
          { key: 'catalog-read', api: 'Catalog Read API|REST|internal', sub: ['product.updated', 'price.changed'], store: 'redis' },
          { key: 'taxonomy', system: 'pim', api: 'Taxonomy API|REST|internal', store: 'postgres' },
          { key: 'attribute-service', system: 'pim', api: 'Attributes API|REST|internal' },
          { key: 'product-import', system: 'pim', calls: ['product-service#2', 'commerce-monolith#7'], chanIn: ['Supplier catalogue drop', 'SFTP', 'supplier-network'] },
        ],
      },
      {
        id: 'pricing',
        name: 'Pricing',
        team: 'team-pricing',
        services: [
          { key: 'pricing', api: 'Price API|gRPC|internal', pub: ['price.changed'], sub: ['cost.updated', 'promotion.updated'], calls: ['currency', 'price-rules'], store: 'postgres' },
          { key: 'price-rules', api: 'Price Rules API|REST|internal', store: 'postgres' },
          { key: 'currency', api: 'FX API|REST|internal', calls: ['ext:fx-rates'], store: 'redis' },
        ],
      },
      {
        id: 'promotions',
        name: 'Promotions',
        team: 'team-promo',
        services: [
          { key: 'promotions-eval', api: 'Promotion Eval API|gRPC|internal', sub: ['promotion.updated'], calls: ['coupon-service'], store: 'redis' },
          { key: 'promotions-admin', api: 'Promotions Admin API|REST|internal', pub: ['promotion.updated'], store: 'postgres' },
          { key: 'coupon-service', api: 'Coupon API|REST|internal', store: 'postgres' },
        ],
      },
      {
        id: 'cart',
        name: 'Cart',
        team: 'team-cart',
        services: [
          { key: 'cart', api: 'Cart API|REST|internal', calls: ['pricing', 'promotions-eval', 'availability', 'tax-calc', 'shipping-quotes', 'feature-flags'], pub: ['cart.updated'], store: 'redis' },
          { key: 'saved-items', api: 'Wishlist API|REST|internal', store: 'dynamodb' },
          { key: 'cart-abandonment', sub: ['cart.updated', 'order.placed'], calls: ['email-service'] },
        ],
      },
      {
        id: 'checkout',
        name: 'Checkout',
        team: 'team-checkout',
        systems: { orchestration: 'Checkout orchestration' },
        services: [
          {
            key: 'checkout',
            system: 'orchestration',
            api: 'Checkout API|REST|internal',
            calls: ['cart', 'pricing', 'tax-calc', 'address-validation', 'shipping-quotes', 'payment-orchestrator', 'fraud-scoring', 'order-service#2', 'loyalty', 'coupon-service', 'feature-flags'],
            pub: ['checkout.completed'],
            store: 'postgres',
          },
          { key: 'address-validation', system: 'orchestration', api: 'Address API|REST|internal', calls: ['ext:loqate'] },
          { key: 'shipping-quotes', api: 'Shipping Quote API|REST|internal', calls: ['delivery-promise', 'carrier-gateway'] },
        ],
      },
      {
        id: 'orders',
        name: 'Orders',
        team: 'team-orders',
        services: [
          {
            key: 'order-service',
            api: ['Order API v1|REST|internal||deprecated', 'Order API v2|REST|internal'],
            pub: ['order.placed', 'order.cancelled', 'order.updated'],
            sub: ['payment.captured', 'shipment.dispatched', 'shipment.delivered', 'return.received'],
            store: 'postgres',
          },
          { key: 'orders-read', api: 'Order History API|REST|internal', sub: ['order.updated'], store: 'dynamodb' },
          { key: 'order-workflow', sub: ['order.placed', 'payment.authorized', 'inventory.reserved'], pub: ['fulfilment.requested'], calls: ['order-service#2', 'allocation-engine', 'svc:wms-gateway!legacy SOAP, no spec'] },
        ],
      },
      {
        id: 'legacy',
        name: 'Legacy commerce',
        team: 'team-legacy',
        reviewed: '2025-12-01',
        services: [
          {
            key: 'commerce-monolith',
            runtime: 'java 8',
            api: [
              'Legacy Orders API|REST|internal|orders',
              'Legacy Order Search|REST|internal|orders',
              'Legacy Order Admin|REST|internal|orders|deprecated',
              'Legacy Customer API|REST|internal|customers',
              'Legacy Customer Search|REST|internal|customers',
              'Legacy Addresses|REST|internal|customers|deprecated',
              'Legacy Catalog API|REST|internal|catalog',
              'Legacy Catalog Feed|REST|internal|catalog',
              'Legacy Categories|REST|internal|catalog|deprecated',
              'Legacy Reports|REST|internal|admin',
              'Legacy Admin API|REST|internal|admin',
              'Legacy Batch Jobs|REST|internal|admin',
            ],
            calls: ['ext:sap-erp'],
            store: 'oracle',
          },
        ],
      },
    ],
  },
  {
    id: 'payments-risk',
    name: 'Payments & Risk',
    head: 'priya',
    domains: [
      {
        id: 'payments',
        name: 'Payments',
        team: 'team-payments',
        systems: { gateway: 'Payment gateway' },
        services: [
          {
            key: 'payment-orchestrator',
            system: 'gateway',
            api: 'Payments API|REST|internal',
            calls: ['payment-adyen', 'payment-stripe', 'payment-paypal', 'payment-klarna', 'card-vault', 'fraud-scoring'],
            pub: ['payment.authorized', 'payment.captured', 'payment.failed'],
            store: 'postgres',
          },
          { key: 'payment-adyen', system: 'gateway', api: 'Adyen Adapter|REST|internal', calls: ['ext:adyen'] },
          { key: 'payment-stripe', system: 'gateway', api: 'Stripe Adapter|REST|internal', calls: ['ext:stripe'] },
          { key: 'payment-paypal', system: 'gateway', api: 'PayPal Adapter|REST|internal', calls: ['ext:paypal'] },
          { key: 'payment-klarna', system: 'gateway', api: 'Klarna Adapter|REST|internal', calls: ['ext:klarna'] },
          { key: 'card-vault', api: 'Card Vault API|gRPC|internal', store: 'postgres' },
          { key: 'psp-webhook-receiver', api: 'PSP Webhooks|REST|partner', pub: ['payment.disputed', 'payment.captured'], extIn: ['adyen', 'stripe', 'paypal'] },
        ],
      },
      {
        id: 'risk',
        name: 'Risk',
        team: 'team-risk',
        services: [
          { key: 'fraud-scoring', api: 'Fraud Score API|gRPC|internal', calls: ['fraud-rules', 'ext:sift', 'feature-store'], store: 'redis' },
          { key: 'fraud-rules', api: 'Fraud Rules API|REST|internal', store: 'postgres' },
          { key: 'chargebacks', api: 'Chargeback API|REST|internal', sub: ['payment.disputed'], calls: ['ext:adyen', 'refund-service'] },
          { key: 'risk-console', status: 'planned', api: 'Risk Review Console|REST|internal', calls: ['fraud-scoring'] },
        ],
      },
      {
        id: 'refunds',
        name: 'Refunds',
        team: 'team-payments',
        services: [{ key: 'refund-service', api: 'Refund API|REST|internal', calls: ['payment-orchestrator'], pub: ['refund.issued'], sub: ['return.received'], store: 'postgres' }],
      },
    ],
  },
  {
    id: 'finance',
    name: 'Finance',
    head: 'omar',
    domains: [
      {
        id: 'billing',
        name: 'Billing',
        team: 'team-billing',
        services: [
          { key: 'invoicing', api: 'Invoice API|REST|internal', sub: ['order.placed', 'shipment.dispatched'], pub: ['invoice.issued'], calls: ['tax-calc', 'commerce-monolith#1'], store: 'postgres' },
          { key: 'credit-notes', sub: ['refund.issued'], pub: ['invoice.issued'], store: 'postgres' },
        ],
      },
      {
        id: 'tax',
        name: 'Tax',
        team: 'team-tax',
        services: [
          { key: 'tax-calc', api: 'Tax API|REST|internal', calls: ['ext:avalara'], store: 'redis' },
          { key: 'tax-reporting', sub: ['invoice.issued'], calls: ['ext:avalara'] },
        ],
      },
      {
        id: 'ledger',
        name: 'Ledger',
        team: 'team-ledger',
        services: [
          { key: 'general-ledger', api: 'Ledger API|gRPC|internal', sub: ['payment.captured', 'refund.issued', 'invoice.issued', 'payout.sent'], store: 'postgres' },
          { key: 'reconciliation', calls: ['general-ledger', 'ext:adyen', 'ext:stripe'], chanIn: ['Bank statements', 'SFTP', 'bank'] },
        ],
      },
      {
        id: 'payouts',
        name: 'Seller payouts',
        team: 'team-marketplace-finance',
        services: [{ key: 'payout-service', api: 'Payout API|REST|internal', sub: ['shipment.delivered', 'order.placed'], pub: ['payout.sent'], calls: ['ext:stripe'], store: 'postgres' }],
      },
    ],
  },
  {
    id: 'fulfilment',
    name: 'Fulfilment & Logistics',
    head: 'maria',
    domains: [
      {
        id: 'inventory',
        name: 'Inventory',
        team: 'team-inventory',
        services: [
          {
            key: 'inventory-service',
            api: 'Inventory API|REST|internal',
            pub: ['inventory.changed', 'inventory.reserved'],
            sub: ['order.placed', 'order.cancelled', 'goods.received', 'return.received'],
            store: 'postgres',
          },
          { key: 'availability', api: 'Availability API|gRPC|internal', sub: ['inventory.changed'], store: 'redis' },
          { key: 'allocation-engine', api: 'Allocation API|REST|internal', calls: ['inventory-service', 'warehouse-locations'] },
        ],
      },
      {
        id: 'warehouse',
        name: 'Warehouse',
        team: 'team-wms',
        systems: { wms: 'Warehouse management' },
        services: [
          { key: 'wms-gateway', system: 'wms', api: 'WMS API|REST|internal', calls: ['ext:manhattan'], sub: ['fulfilment.requested'], pub: ['pick.completed'] },
          { key: 'warehouse-locations', system: 'wms', api: 'Locations API|REST|internal', store: 'postgres' },
          { key: 'packing', system: 'wms', sub: ['pick.completed'], pub: ['parcel.packed'], calls: ['label-service'] },
        ],
      },
      {
        id: 'shipping',
        name: 'Shipping',
        team: 'team-shipping',
        reviewed: '2026-02-02',
        systems: { carriers: 'Carrier integration' },
        services: [
          { key: 'carrier-gateway', system: 'carriers', api: 'Carrier API|REST|internal', calls: ['ext:dhl', 'ext:ups', 'ext:fedex'] },
          { key: 'label-service', system: 'carriers', api: 'Label API|gRPC|internal', calls: ['carrier-gateway'], chanOut: ['DHL manifest drop', 'SFTP', 'dhl'] },
          {
            key: 'tracking-service',
            system: 'carriers',
            api: ['Tracking API|REST|public', 'Carrier Webhooks|REST|partner'],
            pub: ['shipment.dispatched', 'shipment.delivered'],
            sub: ['parcel.packed'],
            extIn: ['dhl@2', 'ups@2', 'fedex@2'],
            store: 'postgres',
          },
          { key: 'delivery-promise', api: 'Delivery Promise API|REST|internal', calls: ['availability', 'carrier-gateway'], disputed: 'checkout' },
        ],
      },
      {
        id: 'returns',
        name: 'Returns',
        team: 'team-returns',
        services: [
          { key: 'returns-service', api: 'Returns API|REST|public', pub: ['return.requested', 'return.received'], calls: ['label-service', 'order-service#2', 'commerce-monolith#1'], store: 'postgres' },
          { key: 'returns-portal-bff', api: 'Returns Portal API|REST|public', calls: ['returns-service', 'orders-read'] },
          { key: 'returns-inspection', sub: ['return.received'], pub: ['goods.received'], calls: ['refund-service'] },
        ],
      },
    ],
  },
  {
    id: 'customer',
    name: 'Customer',
    head: 'sofia',
    domains: [
      {
        id: 'accounts',
        name: 'Accounts',
        team: 'team-accounts',
        services: [
          { key: 'customer-identity', api: 'Customer Login API|REST|public', calls: ['ext:auth0'], pub: ['customer.registered'], store: 'postgres' },
          { key: 'customer-profile', api: 'Profile API|REST|internal', pub: ['customer.updated'], sub: ['customer.registered'], store: 'postgres' },
          { key: 'address-book', api: 'Address Book API|REST|internal', calls: ['address-validation'], store: 'postgres' },
          { key: 'consent', api: 'Consent API|REST|internal', pub: ['consent.changed'], store: 'postgres' },
        ],
      },
      {
        id: 'loyalty',
        name: 'Loyalty',
        team: 'team-loyalty',
        services: [
          { key: 'loyalty', api: 'Loyalty API|REST|internal', sub: ['order.placed', 'return.received'], pub: ['points.earned'], store: 'postgres' },
          { key: 'rewards-catalog', api: 'Rewards API|REST|internal', calls: ['loyalty'] },
        ],
      },
      {
        id: 'reviews',
        name: 'Reviews',
        team: 'team-ugc',
        services: [
          { key: 'reviews-read', api: 'Reviews API|REST|public', sub: ['review.published'], store: 'elasticsearch' },
          { key: 'reviews-ingest', api: 'Submit Review API|REST|public', pub: ['review.submitted'], calls: ['orders-read'] },
          { key: 'moderation', sub: ['review.submitted'], pub: ['review.published'], calls: ['model-serving', 'ext:openai'] },
        ],
      },
    ],
  },
  {
    id: 'engagement',
    name: 'Marketing & Engagement',
    head: 'lena',
    domains: [
      {
        id: 'campaigns',
        name: 'Campaigns',
        team: 'team-crm',
        services: [
          { key: 'campaign-manager', api: 'Campaign API|REST|internal', pub: ['campaign.launched'], calls: ['audience-builder'] },
          { key: 'audience-builder', api: 'Audience API|REST|internal', sub: ['customer.updated', 'order.placed', 'session.enriched'], store: 'snowflake' },
        ],
      },
      {
        id: 'messaging',
        name: 'Messaging',
        team: 'team-messaging',
        services: [
          {
            key: 'email-service',
            api: 'Email API|REST|internal',
            sub: ['order.placed', 'shipment.dispatched', 'return.requested', 'refund.issued', 'customer.registered', 'campaign.launched'],
            calls: ['ext:sendgrid', 'preference-center'],
          },
          { key: 'sms-service', api: 'SMS API|REST|internal', sub: ['shipment.dispatched', 'order.placed'], calls: ['ext:twilio', 'preference-center'] },
          { key: 'push-service', api: 'Push API|REST|internal', sub: ['shipment.delivered'], calls: ['ext:firebase'] },
          { key: 'preference-center', api: 'Preferences API|REST|public', sub: ['consent.changed'], store: 'postgres' },
        ],
      },
      {
        id: 'acquisition',
        name: 'Acquisition',
        team: 'team-growth',
        services: [
          { key: 'product-feeds', sub: ['product.updated', 'price.changed', 'inventory.changed'], calls: ['ext:google-merchant', 'ext:meta-ads'] },
          { key: 'affiliate-tracking', api: 'Affiliate API|REST|partner', sub: ['order.placed'], calls: ['ext:awin'] },
          { key: 'seo-sitemaps', sub: ['product.updated'], store: 's3' },
        ],
      },
    ],
  },
  {
    id: 'data',
    name: 'Data & Analytics',
    head: 'kenji',
    domains: [
      {
        id: 'events',
        name: 'Event collection',
        team: 'team-data-platform',
        services: [
          { key: 'event-collector', api: 'Collect API|REST|public', pub: ['page.viewed', 'product.viewed'] },
          { key: 'clickstream-enricher', sub: ['page.viewed', 'product.viewed'], pub: ['session.enriched'] },
          { key: 'cdc-connector', sub: ['order.updated'], calls: ['ext:snowflake'] },
        ],
      },
      {
        id: 'analytics',
        name: 'Analytics',
        team: 'team-analytics',
        services: [
          { key: 'lakehouse-loader', sub: ['order.placed', 'payment.captured', 'shipment.dispatched', 'session.enriched', 'inventory.changed', 'refund.issued'], calls: ['ext:snowflake'] },
          { key: 'metrics-service', api: 'Metrics API|GraphQL|internal', calls: ['ext:snowflake'] },
          { key: 'bi-exports', calls: ['metrics-service'], chanOut: ['Finance BI extract', 'SFTP', 'sap-erp'] },
        ],
      },
      {
        id: 'ml',
        name: 'Machine learning',
        team: 'team-ml',
        services: [
          { key: 'model-serving', api: 'Model Serving API|gRPC|internal', calls: ['feature-store'] },
          { key: 'feature-store', api: 'Feature Store API|gRPC|internal', store: 'redis' },
          { key: 'feature-pipelines', sub: ['session.enriched', 'order.placed'], calls: ['feature-store'] },
          { key: 'demand-forecast', api: 'Forecast API|REST|internal', pub: ['forecast.published'], calls: ['metrics-service'] },
        ],
      },
    ],
  },
  {
    id: 'supply',
    name: 'Supply Chain',
    head: 'diego',
    domains: [
      {
        id: 'procurement',
        name: 'Procurement',
        team: 'team-procurement',
        services: [
          { key: 'purchase-orders', api: 'Purchase Order API|REST|internal', sub: ['forecast.published'], pub: ['po.created'], calls: ['supplier-service'], store: 'postgres' },
          { key: 'supplier-service', api: 'Supplier API|REST|partner', calls: ['ext:supplier-network'], store: 'postgres' },
          { key: 'receiving', sub: ['po.created'], pub: ['goods.received'], calls: ['wms-gateway'] },
        ],
      },
      {
        id: 'costing',
        name: 'Costing',
        team: 'team-costing',
        services: [{ key: 'cost-service', api: 'Cost API|REST|internal', pub: ['cost.updated'], calls: ['ext:sap-erp'], store: 'postgres' }],
      },
    ],
  },
  {
    id: 'marketplace',
    name: 'Marketplace',
    head: 'ines',
    domains: [
      {
        id: 'sellers',
        name: 'Sellers',
        team: 'team-marketplace',
        services: [
          { key: 'seller-portal-bff', api: 'Seller Portal API|REST|partner', calls: ['seller-onboarding', 'listings', 'seller-orders', 'payout-service', 'metrics-service'] },
          { key: 'seller-onboarding', api: 'Onboarding API|REST|internal', calls: ['ext:onfido', 'payout-service'], store: 'postgres' },
          { key: 'listings', api: 'Listings API|REST|internal', pub: ['listing.published'], calls: ['taxonomy', 'attribute-service'], store: 'postgres' },
          { key: 'seller-orders', api: 'Seller Orders API|REST|internal', sub: ['order.placed', 'shipment.dispatched'], store: 'postgres' },
          { key: 'social-commerce', status: 'planned', api: 'Social Shop API|REST|partner', calls: ['catalog-read', 'ext:meta-ads'] },
        ],
      },
    ],
  },
  {
    id: 'support',
    name: 'Customer Support',
    head: 'noah',
    domains: [
      {
        id: 'service-desk',
        name: 'Service desk',
        team: 'team-support',
        services: [
          { key: 'agent-console-bff', api: 'Agent Console API|REST|internal', calls: ['orders-read', 'customer-profile', 'returns-service', 'refund-service', 'loyalty', 'commerce-monolith#4', 'ticketing'] },
          { key: 'ticketing', api: 'Ticketing API|REST|internal', calls: ['ext:zendesk'] },
          { key: 'chat-assistant', api: 'Chat API|REST|public', calls: ['model-serving', 'orders-read', 'ext:openai', 'ticketing'] },
        ],
      },
    ],
  },
  {
    id: 'platform',
    name: 'Platform',
    head: 'lee',
    domains: [
      {
        id: 'edge',
        name: 'Edge & identity',
        team: 'team-platform-edge',
        services: [
          { key: 'api-gateway', role: 'platform', api: 'Edge Gateway|REST|public' },
          { key: 'auth', role: 'platform', api: 'Auth API|REST|internal', calls: ['ext:auth0'], store: 'postgres' },
        ],
      },
      {
        id: 'runtime',
        name: 'Runtime',
        team: 'team-platform',
        services: [
          { key: 'feature-flags', role: 'platform', api: 'Flags API|REST|internal', calls: ['ext:launchdarkly'] },
          { key: 'config-service', role: 'platform', api: 'Config API|gRPC|internal' },
          { key: 'secrets', role: 'platform', api: 'Secrets API|gRPC|internal', store: 'hsm' },
        ],
      },
      {
        id: 'observability',
        name: 'Observability',
        team: 'team-sre',
        services: [{ key: 'telemetry-collector', role: 'platform', api: 'OTLP Ingest|gRPC|internal', calls: ['ext:datadog'] }],
      },
    ],
  },
];

const EXTERNALS: Record<string, [string, string, string]> = {
  adyen: ['Adyen', 'SaaS', 'team-payments'],
  stripe: ['Stripe', 'SaaS', 'team-payments'],
  paypal: ['PayPal', 'partner', 'team-payments'],
  klarna: ['Klarna', 'partner', 'team-payments'],
  sift: ['Sift', 'SaaS', 'team-risk'],
  avalara: ['Avalara', 'SaaS', 'team-tax'],
  dhl: ['DHL', 'partner', 'team-shipping'],
  ups: ['UPS', 'partner', 'team-shipping'],
  fedex: ['FedEx', 'partner', 'team-shipping'],
  loqate: ['Loqate', 'SaaS', 'team-checkout'],
  sendgrid: ['SendGrid', 'SaaS', 'team-messaging'],
  twilio: ['Twilio', 'SaaS', 'team-messaging'],
  firebase: ['Firebase Cloud Messaging', 'SaaS', 'team-messaging'],
  'google-merchant': ['Google Merchant Center', 'SaaS', 'team-growth'],
  'meta-ads': ['Meta Ads', 'SaaS', 'team-growth'],
  awin: ['Awin', 'partner', 'team-growth'],
  snowflake: ['Snowflake', 'SaaS', 'team-analytics'],
  zendesk: ['Zendesk', 'SaaS', 'team-support'],
  openai: ['OpenAI', 'SaaS', 'team-ml'],
  auth0: ['Auth0', 'SaaS', 'team-platform-edge'],
  manhattan: ['Manhattan WMS', 'SaaS', 'team-wms'],
  onfido: ['Onfido', 'SaaS', 'team-marketplace'],
  cloudinary: ['Cloudinary', 'SaaS', 'team-content'],
  'fx-rates': ['ECB FX feed', 'other org', 'team-pricing'],
  'sap-erp': ['SAP ERP (corporate)', 'other org', 'team-ledger'],
  bank: ['House bank', 'partner', 'team-ledger'],
  'supplier-network': ['Supplier network', 'partner', 'team-procurement'],
  launchdarkly: ['LaunchDarkly', 'SaaS', 'team-platform'],
  datadog: ['Datadog', 'SaaS', 'team-sre'],
};

const TOURS = [
  {
    id: 'checkout',
    name: 'Checkout: from click to paid order',
    description: 'The money path, end to end',
    steps: [
      { focus: 'digital', caption: 'Shoppers arrive through the web storefront and the mobile apps. Both talk to a backend-for-frontend rather than to domain services directly.' },
      { focus: 'storefront/storefront-bff', caption: 'The Storefront BFF stitches about a dozen domain APIs (catalog, search, pricing, cart, recommendations) into one GraphQL graph.' },
      { trace: ['storefront/web-storefront', 'payments/payment-adyen'], caption: 'A checkout request: web → BFF → Checkout orchestration → Payments → the Adyen adapter.' },
      { focus: 'payments', caption: 'Payment orchestration routes to four payment providers. Captures and disputes come back asynchronously through PSP webhooks.' },
      { impact: 'payments/payment-orchestrator', direction: 'dependents', caption: 'If payment orchestration is down, this is the blast radius: checkout, mobile, refunds and every flow behind them.' },
      { focus: 'orders/order-placed', caption: 'order.placed is the busiest event: fulfilment, finance, loyalty, messaging, marketplace and analytics all consume it.' },
    ],
  },
  {
    id: 'fulfilment',
    name: 'Order to doorstep',
    description: 'Workflow, warehouse and carriers',
    steps: [
      { trace: ['orders/order-workflow', 'warehouse/wms-gateway'], caption: 'Once payment is authorised and stock reserved, the order workflow raises a fulfilment request for the warehouse.' },
      { focus: 'warehouse', caption: 'Warehouse management runs on Manhattan WMS behind a gateway; picking and packing emit events as parcels move.' },
      { trace: ['warehouse/packing', 'ext/dhl'], caption: 'Packing prints labels through the carrier integration; DHL also receives a nightly manifest over SFTP.' },
      { impact: 'shipping/carrier-gateway', direction: 'dependents', caption: 'The carrier gateway is a single point of failure for labels, quotes and delivery promises.' },
    ],
  },
  {
    id: 'returns',
    name: 'Returns and refunds',
    steps: [
      { trace: ['returns/returns-portal-bff', 'payments/payment-stripe'], caption: 'A return travels from the portal through the returns service; once received, the refund flows back through payments.' },
      { impact: 'refunds/refund-service', direction: 'dependencies', caption: 'Everything a refund needs to succeed.' },
    ],
  },
  {
    id: 'legacy',
    name: 'Strangling the monolith',
    steps: [
      { focus: 'legacy/commerce-monolith', caption: 'The legacy commerce monolith still exposes twelve APIs, grouped here by area. Three are already deprecated.' },
      { impact: 'legacy/commerce-monolith', direction: 'dependents', caption: 'Who still calls it: invoicing, returns, catalog import and the support console.' },
    ],
  },
];

// ── expand ────────────────────────────────────────────────────────────────────
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const OUT = join('examples', 'ecommerce', 'registry');

interface Svc {
  s: S;
  dom: Dom;
  dept: Dept;
  id: string;
  apis: Array<{ id: string; name: string; style: string; audience: string; tag?: string; deprecated: boolean }>;
}
const svcs = new Map<string, Svc>();
for (const dept of DEPTS) {
  for (const dom of dept.domains) {
    for (const s of dom.services) {
      if (svcs.has(s.key)) throw new Error(`duplicate service key ${s.key}`);
      const apis = ([] as string[]).concat(s.api ?? []).map((a) => {
        const [name, style, audience, tag, dep] = a.split('|');
        return { id: `${dom.id}/${slug(name)}`, name, style, audience, ...(tag ? { tag } : {}), deprecated: dep === 'deprecated' };
      });
      svcs.set(s.key, { s, dom, dept, id: `${dom.id}/${s.key}`, apis });
    }
  }
}

// Ids must be unique across departments, domains, services and APIs.
{
  const ids = new Map<string, string>();
  const claim = (id: string, what: string) => {
    if (ids.has(id)) throw new Error(`id ${id} used by ${ids.get(id)} and ${what}`);
    ids.set(id, what);
  };
  for (const d of DEPTS) {
    claim(d.id, `department ${d.name}`);
    for (const dom of d.domains) claim(dom.id, `domain ${dom.name}`);
  }
  for (const v of svcs.values()) {
    claim(v.id, `service ${v.s.key}`);
    for (const a of v.apis) claim(a.id, `API ${a.name}`);
  }
}

// Topic owners: the first publisher.
const topics = new Map<string, { id: string; owner: Svc }>();
for (const v of svcs.values()) {
  for (const ev of v.s.pub ?? []) if (!topics.has(ev)) topics.set(ev, { id: `${v.dom.id}/${slug(ev)}`, owner: v });
}

const docs = new Map<string, any>();
const doc = (dom: Dom) => docs.get(dom.id)!;
for (const dept of DEPTS) {
  for (const dom of dept.domains) {
    docs.set(dom.id, {
      domain: { id: dom.id, name: dom.name, department: dept.id, owningTeam: dom.team, reviewedAt: dom.reviewed ?? '2026-08-15', reviewedBy: dept.head },
      ...(dom.systems ? { systems: Object.entries(dom.systems).map(([id, name]) => ({ id: `${dom.id}/${id}`, name })) } : {}),
      services: [],
      apis: [],
      topics: [],
      channels: [],
      datastores: [],
      connections: [],
    });
  }
}
const externalsConnections: Array<Record<string, string>> = [];
const used = new Set<string>();
const ext = (id: string) => {
  if (!EXTERNALS[id]) throw new Error(`unknown external ${id}`);
  used.add(id);
  return `ext/${id}`;
};
const apiOf = (ref: string, from: string) => {
  const [key, n] = ref.split('#');
  const t = svcs.get(key);
  if (!t) throw new Error(`${from}: unknown service ${key}`);
  const api = t.apis[(n ? Number(n) : 1) - 1];
  if (!api) throw new Error(`${from}: ${key} has no API #${n ?? 1}`);
  return api.id;
};

for (const v of svcs.values()) {
  const d = doc(v.dom);
  const { s } = v;
  d.services.push({
    id: v.id,
    name: s.key,
    owningTeam: v.dom.team,
    ...(s.system ? { system: `${v.dom.id}/${s.system}` } : {}),
    ...(s.runtime ? { runtime: s.runtime } : {}),
    ...(s.role ? { role: s.role } : {}),
    ...(s.status ? { status: s.status } : {}),
    ...(s.disputed ? { ownership: 'disputed', claimant: s.disputed } : {}),
  });
  v.apis.forEach((a, i) => {
    const prev = v.apis[i - 1];
    d.apis.push({
      id: a.id,
      name: a.name,
      hostedBy: v.id,
      style: a.style,
      audience: a.audience,
      ...(a.tag || v.apis.length > 8 ? { tags: [a.tag ?? 'other'] } : {}),
      ...(a.deprecated ? { status: 'deprecated' } : {}),
      ...(prev?.deprecated && !a.deprecated && a.name.includes(' v') ? { supersedes: prev.id } : {}),
    });
  });
  if (s.store) d.datastores.push({ id: `${v.dom.id}/${s.key}-db`, name: `${s.key}-db`, technology: s.store, ownedBy: v.id });

  const conns = d.connections as Array<Record<string, string>>;
  for (const c of s.calls ?? []) {
    if (c.startsWith('ext:')) conns.push({ from: v.id, to: ext(c.slice(4)) });
    else if (c.startsWith('svc:')) {
      const [key, gap] = c.slice(4).split('!');
      conns.push({ from: v.id, to: svcs.get(key)!.id, gap });
    } else conns.push({ from: v.id, to: apiOf(c, s.key) });
  }
  // Public and partner APIs authenticate callers through the platform auth service.
  if (v.apis.some((a) => a.audience !== 'internal') && s.role !== 'platform') conns.push({ from: v.id, to: apiOf('auth', s.key) });
  for (const ev of s.pub ?? []) {
    const t = topics.get(ev)!;
    conns.push({ from: v.id, to: t.id });
  }
  for (const ev of s.sub ?? []) {
    const t = topics.get(ev);
    if (!t) throw new Error(`${s.key}: nobody publishes ${ev}`);
    conns.push({ from: t.id, to: v.id });
  }
  for (const r of s.reads ?? []) conns.push({ from: v.id, to: `${svcs.get(r)!.dom.id}/${r}-db` });
  if (s.chanOut) {
    const [name, tech, to] = s.chanOut;
    const id = `${v.dom.id}/${slug(name)}`;
    d.channels.push({ id, name, technology: tech, ownedBy: v.id });
    conns.push({ from: v.id, to: id }, { from: id, to: ext(to) });
  }
  if (s.chanIn) {
    const [name, tech, from] = s.chanIn;
    const id = `${v.dom.id}/${slug(name)}`;
    d.channels.push({ id, name, technology: tech, ownedBy: v.id });
    externalsConnections.push({ from: ext(from), to: id });
    conns.push({ from: id, to: v.id });
  }
  for (const e of s.extIn ?? []) {
    const [id, n] = e.split('@');
    externalsConnections.push({ from: ext(id), to: v.apis[(n ? Number(n) : 1) - 1].id });
  }
}
for (const [ev, t] of topics) {
  doc(t.owner.dom).topics.push({ id: t.id, name: `${ev}.v1`, ownedBy: t.owner.id, cluster: `${t.owner.dept.id}-events` });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'domains'), { recursive: true });
const write = (file: string, data: unknown) => writeFileSync(join(OUT, file), stringify(data, { lineWidth: 140 }));
write('departments.yaml', { departments: DEPTS.map((d) => ({ id: d.id, name: d.name, head: d.head })) });
write('clusters.yaml', { clusters: DEPTS.map((d) => ({ id: `${d.id}-events`, name: `${d.id}-events`, environment: 'prod' })) });
write('externals.yaml', {
  externals: [...used].sort().map((id) => ({ id: `ext/${id}`, name: EXTERNALS[id][0], kind: EXTERNALS[id][1], ownerTeam: EXTERNALS[id][2] })),
  connections: externalsConnections,
});
for (const [id, d] of docs) {
  for (const k of ['apis', 'topics', 'channels', 'datastores', 'connections', 'services']) if (!d[k].length) delete d[k];
  write(`domains/${id}.yaml`, d);
}
write('tours.yaml', { tours: TOURS });

const count = (k: string) => [...docs.values()].reduce((n, d) => n + (d[k]?.length ?? 0), 0);
console.log(
  `wrote ${OUT}: ${DEPTS.length} departments, ${docs.size} domains, ${svcs.size} services, ${count('apis')} APIs, ${topics.size} topics, ` +
    `${count('channels')} channels, ${count('datastores')} datastores, ${used.size} externals, ${count('connections') + externalsConnections.length} connections, ${TOURS.length} tours`,
);
