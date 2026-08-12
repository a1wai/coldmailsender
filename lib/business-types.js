/**
 * lib/business-types.js
 * ---------------------------------------------------------------------------
 * Industry -> OpenStreetMap tag filters.
 *
 * OSM has no single "industry" field; businesses are tagged across `office`,
 * `shop`, `amenity`, `craft`, `leisure`, `tourism` and `healthcare`. This table
 * maps the categories people actually search for onto the tags that hold them.
 *
 * Three fields per entry, used by the broadening cascade in `lib/places.js`:
 *
 *   filters   Exact tags. Precise, but only finds businesses a mapper tagged
 *             correctly — which in most of the world is a minority of them.
 *   broad     Container keys to fall back to. `office=*` catches the marketing
 *             agency someone tagged `office=company` instead of
 *             `office=advertising_agency`.
 *   synonyms  Words to match against the name when searching `broad`. Without
 *             these, "any office within 10 km" is thousands of irrelevant rows.
 *             Multilingual on purpose: OSM names are in the local language.
 *   query     What to type into Google Places / Maps for the same thing.
 *
 * Kept free of any Node dependency so the picker in the browser and the query
 * builder on the server read from exactly the same list.
 */

export const BUSINESS_TYPES = [
  {
    id: 'real_estate',
    label: 'Real estate agents',
    filters: [['office', 'estate_agent'], ['shop', 'estate_agent']],
    broad: ['office', 'shop'],
    synonyms: ['estate', 'realty', 'realtor', 'property', 'properties', 'makelaar', 'immobil', 'inmobiliaria', 'immo'],
    query: 'real estate agent',
  },
  {
    id: 'restaurant',
    label: 'Restaurants',
    filters: [['amenity', 'restaurant']],
    broad: ['amenity'],
    synonyms: ['restaurant', 'bistro', 'brasserie', 'eatery', 'kitchen', 'grill', 'trattoria', 'osteria'],
    query: 'restaurant',
  },
  {
    id: 'cafe',
    label: 'Cafés & coffee shops',
    filters: [['amenity', 'cafe']],
    broad: ['amenity', 'shop'],
    synonyms: ['cafe', 'café', 'coffee', 'espresso', 'roaster', 'koffie', 'kaffee'],
    query: 'coffee shop',
  },
  {
    id: 'bar',
    label: 'Bars & pubs',
    filters: [['amenity', 'bar'], ['amenity', 'pub'], ['amenity', 'biergarten']],
    broad: ['amenity'],
    synonyms: ['bar', 'pub', 'tavern', 'taproom', 'brewery', 'lounge', 'kroeg', 'cocktail'],
    query: 'bar',
  },
  {
    id: 'hotel',
    label: 'Hotels & guest houses',
    filters: [['tourism', 'hotel'], ['tourism', 'guest_house'], ['tourism', 'hostel'], ['tourism', 'apartment']],
    broad: ['tourism'],
    synonyms: ['hotel', 'inn', 'lodge', 'guest', 'hostel', 'resort', 'bnb', 'pension'],
    query: 'hotel',
  },
  {
    id: 'gym',
    label: 'Gyms & fitness studios',
    filters: [['leisure', 'fitness_centre'], ['leisure', 'sports_centre'], ['leisure', 'sports_hall']],
    broad: ['leisure', 'shop'],
    synonyms: ['gym', 'fitness', 'crossfit', 'pilates', 'yoga', 'sport', 'training', 'health club'],
    query: 'gym',
  },
  {
    id: 'hairdresser',
    label: 'Hair salons & barbers',
    filters: [['shop', 'hairdresser'], ['shop', 'beauty'], ['shop', 'barber']],
    broad: ['shop'],
    synonyms: ['hair', 'barber', 'salon', 'beauty', 'kapper', 'coiffure', 'friseur', 'peluqueria'],
    query: 'hair salon',
  },
  {
    id: 'dentist',
    label: 'Dentists',
    filters: [['amenity', 'dentist'], ['healthcare', 'dentist']],
    broad: ['amenity', 'healthcare', 'office'],
    synonyms: ['dent', 'ortho', 'tandarts', 'zahn', 'smile', 'oral'],
    query: 'dentist',
  },
  {
    id: 'doctor',
    label: 'Doctors & clinics',
    filters: [['amenity', 'doctors'], ['amenity', 'clinic'], ['healthcare', 'doctor'], ['healthcare', 'centre']],
    broad: ['amenity', 'healthcare'],
    synonyms: ['clinic', 'doctor', 'medical', 'health', 'practice', 'huisarts', 'praxis', 'medic'],
    query: 'medical clinic',
  },
  {
    id: 'veterinary',
    label: 'Veterinarians',
    filters: [['amenity', 'veterinary'], ['healthcare', 'veterinary']],
    broad: ['amenity', 'healthcare', 'shop'],
    synonyms: ['vet', 'animal', 'dieren', 'tier', 'pet clinic'],
    query: 'veterinarian',
  },
  {
    id: 'lawyer',
    label: 'Lawyers & law firms',
    filters: [['office', 'lawyer'], ['office', 'notary']],
    broad: ['office'],
    synonyms: ['law', 'legal', 'attorney', 'solicitor', 'advocaat', 'advocaten', 'notar', 'anwalt', 'abogad'],
    query: 'law firm',
  },
  {
    id: 'accountant',
    label: 'Accountants',
    filters: [['office', 'accountant'], ['office', 'tax_advisor'], ['office', 'financial']],
    broad: ['office'],
    synonyms: ['account', 'tax', 'bookkeep', 'audit', 'boekhoud', 'steuer', 'fiscal', 'cpa'],
    query: 'accountant',
  },
  {
    id: 'insurance',
    label: 'Insurance brokers',
    filters: [['office', 'insurance']],
    broad: ['office'],
    synonyms: ['insur', 'assur', 'verzeker', 'seguros', 'broker', 'underwrit'],
    query: 'insurance broker',
  },
  {
    id: 'marketing',
    label: 'Marketing & ad agencies',
    filters: [['office', 'advertising_agency'], ['office', 'marketing'], ['office', 'graphic_design']],
    broad: ['office', 'shop'],
    synonyms: ['market', 'agency', 'advert', 'media', 'brand', 'digital', 'creative', 'studio', 'design', 'seo', 'reclame', 'werbe'],
    query: 'marketing agency',
  },
  {
    id: 'it',
    label: 'IT & software companies',
    filters: [['office', 'it'], ['office', 'telecommunication'], ['office', 'company']],
    broad: ['office', 'shop'],
    synonyms: ['it', 'software', 'tech', 'digital', 'web', 'data', 'cloud', 'systems', 'solutions', 'computer', 'dev'],
    query: 'software company',
  },
  {
    id: 'architect',
    label: 'Architects',
    filters: [['office', 'architect']],
    broad: ['office'],
    synonyms: ['architect', 'architectuur', 'bureau', 'design', 'planning'],
    query: 'architect',
  },
  {
    id: 'photographer',
    label: 'Photographers',
    filters: [['craft', 'photographer'], ['shop', 'photo'], ['shop', 'photo_studio']],
    broad: ['craft', 'shop', 'office'],
    synonyms: ['photo', 'foto', 'studio', 'imaging', 'lens', 'portrait'],
    query: 'photographer',
  },
  {
    id: 'builder',
    label: 'Builders & contractors',
    filters: [['craft', 'builder'], ['craft', 'carpenter'], ['office', 'construction_company']],
    broad: ['craft', 'office'],
    synonyms: ['build', 'construct', 'contract', 'renovat', 'bouw', 'bau', 'joinery', 'carpent'],
    query: 'construction company',
  },
  {
    id: 'plumber',
    label: 'Plumbers',
    filters: [['craft', 'plumber'], ['craft', 'hvac']],
    broad: ['craft', 'shop'],
    synonyms: ['plumb', 'heating', 'boiler', 'loodgieter', 'installat', 'sanitair', 'hvac'],
    query: 'plumber',
  },
  {
    id: 'electrician',
    label: 'Electricians',
    filters: [['craft', 'electrician'], ['craft', 'electronics_repair']],
    broad: ['craft', 'shop'],
    synonyms: ['electr', 'elektr', 'wiring', 'lighting', 'solar'],
    query: 'electrician',
  },
  {
    id: 'car_dealer',
    label: 'Car dealers & garages',
    filters: [['shop', 'car'], ['shop', 'car_repair'], ['shop', 'car_parts']],
    broad: ['shop', 'craft'],
    synonyms: ['car', 'auto', 'motor', 'garage', 'vehicle', 'tyre', 'tire', 'bodyshop'],
    query: 'car dealership',
  },
  {
    id: 'bakery',
    label: 'Bakeries',
    filters: [['shop', 'bakery'], ['shop', 'pastry']],
    broad: ['shop'],
    synonyms: ['baker', 'bread', 'patisserie', 'pastry', 'cake', 'bakkerij', 'bäcker', 'panader'],
    query: 'bakery',
  },
  {
    id: 'florist',
    label: 'Florists',
    filters: [['shop', 'florist'], ['shop', 'garden_centre']],
    broad: ['shop'],
    synonyms: ['flor', 'flower', 'bloem', 'blumen', 'bloom', 'petal', 'garden'],
    query: 'florist',
  },
  {
    id: 'clothes',
    label: 'Clothing & fashion shops',
    filters: [['shop', 'clothes'], ['shop', 'boutique'], ['shop', 'fashion_accessories'], ['shop', 'shoes']],
    broad: ['shop'],
    synonyms: ['cloth', 'fashion', 'boutique', 'wear', 'apparel', 'shoe', 'mode', 'kleding', 'style'],
    query: 'clothing boutique',
  },
  {
    id: 'furniture',
    label: 'Furniture & interiors',
    filters: [['shop', 'furniture'], ['shop', 'interior_decoration'], ['shop', 'kitchen']],
    broad: ['shop', 'office'],
    synonyms: ['furnit', 'interior', 'meubel', 'wonen', 'living', 'kitchen', 'decor', 'design'],
    query: 'furniture store',
  },
  {
    id: 'jewelry',
    label: 'Jewellers',
    filters: [['shop', 'jewelry'], ['craft', 'jeweller'], ['shop', 'watches']],
    broad: ['shop', 'craft'],
    synonyms: ['jewel', 'juwel', 'gold', 'silver', 'diamond', 'watch', 'bijou'],
    query: 'jewelry store',
  },
  {
    id: 'travel',
    label: 'Travel agencies',
    filters: [['shop', 'travel_agency'], ['office', 'travel_agent']],
    broad: ['shop', 'office'],
    synonyms: ['travel', 'tour', 'reis', 'reise', 'voyage', 'holiday', 'viaje'],
    query: 'travel agency',
  },
  {
    id: 'school',
    label: 'Schools & training',
    filters: [['amenity', 'school'], ['amenity', 'college'], ['amenity', 'language_school'], ['amenity', 'driving_school']],
    broad: ['amenity', 'office'],
    synonyms: ['school', 'academy', 'college', 'institute', 'training', 'educat', 'learn', 'opleiding'],
    query: 'school',
  },
  {
    id: 'childcare',
    label: 'Nurseries & childcare',
    filters: [['amenity', 'childcare'], ['amenity', 'kindergarten']],
    broad: ['amenity'],
    synonyms: ['child', 'kids', 'nursery', 'daycare', 'kinder', 'creche', 'crèche', 'peuter'],
    query: 'daycare',
  },
  {
    id: 'cleaning',
    label: 'Cleaning services',
    filters: [['shop', 'laundry'], ['shop', 'dry_cleaning'], ['office', 'cleaning'], ['craft', 'cleaning']],
    broad: ['shop', 'office', 'craft'],
    synonyms: ['clean', 'laundry', 'wash', 'schoonmaak', 'reinig', 'valet', 'janitor'],
    query: 'cleaning service',
  },
  {
    id: 'pet',
    label: 'Pet shops & groomers',
    filters: [['shop', 'pet'], ['shop', 'pet_grooming']],
    broad: ['shop', 'craft'],
    synonyms: ['pet', 'dog', 'cat', 'groom', 'dieren', 'animal', 'tier'],
    query: 'pet store',
  },
  {
    id: 'any_shop',
    label: 'Any shop (all retail)',
    filters: [['shop', '*']],
    broad: [],
    synonyms: [],
    query: 'shops',
  },
  {
    id: 'any_office',
    label: 'Any office / business',
    filters: [['office', '*']],
    broad: [],
    synonyms: [],
    query: 'businesses',
  },
  {
    id: 'any_business',
    label: 'Everything with a name (widest)',
    filters: [['shop', '*'], ['office', '*'], ['craft', '*'], ['amenity', '*'], ['tourism', '*'], ['leisure', '*']],
    broad: [],
    synonyms: [],
    query: 'businesses',
  },
];

/** Lookup by id, used by the query builder. */
export function findBusinessType(id) {
  return BUSINESS_TYPES.find((entry) => entry.id === id) || null;
}
