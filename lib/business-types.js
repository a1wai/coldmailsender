/**
 * lib/business-types.js
 * ---------------------------------------------------------------------------
 * Industry -> OpenStreetMap tag filters.
 *
 * OSM has no single "industry" field; businesses are tagged across `office`,
 * `shop`, `amenity`, `craft`, `leisure`, `tourism` and `healthcare`. This table
 * maps the categories people actually search for onto the tags that hold them.
 *
 * Kept free of any Node dependency so the picker in the browser and the query
 * builder on the server read from exactly the same list.
 */

export const BUSINESS_TYPES = [
  { id: 'real_estate', label: 'Real estate agents', filters: [['office', 'estate_agent'], ['shop', 'estate_agent']] },
  { id: 'restaurant', label: 'Restaurants', filters: [['amenity', 'restaurant']] },
  { id: 'cafe', label: 'Cafés & coffee shops', filters: [['amenity', 'cafe']] },
  { id: 'bar', label: 'Bars & pubs', filters: [['amenity', 'bar'], ['amenity', 'pub']] },
  { id: 'hotel', label: 'Hotels & guest houses', filters: [['tourism', 'hotel'], ['tourism', 'guest_house']] },
  { id: 'gym', label: 'Gyms & fitness studios', filters: [['leisure', 'fitness_centre']] },
  { id: 'hairdresser', label: 'Hair salons & barbers', filters: [['shop', 'hairdresser'], ['shop', 'beauty']] },
  { id: 'dentist', label: 'Dentists', filters: [['amenity', 'dentist'], ['healthcare', 'dentist']] },
  { id: 'doctor', label: 'Doctors & clinics', filters: [['amenity', 'doctors'], ['amenity', 'clinic']] },
  { id: 'veterinary', label: 'Veterinarians', filters: [['amenity', 'veterinary']] },
  { id: 'lawyer', label: 'Lawyers & law firms', filters: [['office', 'lawyer']] },
  { id: 'accountant', label: 'Accountants', filters: [['office', 'accountant'], ['office', 'tax_advisor']] },
  { id: 'insurance', label: 'Insurance brokers', filters: [['office', 'insurance']] },
  { id: 'marketing', label: 'Marketing & ad agencies', filters: [['office', 'advertising_agency'], ['office', 'marketing']] },
  { id: 'it', label: 'IT & software companies', filters: [['office', 'it'], ['office', 'company']] },
  { id: 'architect', label: 'Architects', filters: [['office', 'architect']] },
  { id: 'photographer', label: 'Photographers', filters: [['craft', 'photographer'], ['shop', 'photo']] },
  { id: 'builder', label: 'Builders & contractors', filters: [['craft', 'builder'], ['office', 'construction_company']] },
  { id: 'plumber', label: 'Plumbers', filters: [['craft', 'plumber']] },
  { id: 'electrician', label: 'Electricians', filters: [['craft', 'electrician']] },
  { id: 'car_dealer', label: 'Car dealers & garages', filters: [['shop', 'car'], ['shop', 'car_repair']] },
  { id: 'bakery', label: 'Bakeries', filters: [['shop', 'bakery']] },
  { id: 'florist', label: 'Florists', filters: [['shop', 'florist']] },
  { id: 'clothes', label: 'Clothing & fashion shops', filters: [['shop', 'clothes'], ['shop', 'boutique']] },
  { id: 'furniture', label: 'Furniture & interiors', filters: [['shop', 'furniture'], ['shop', 'interior_decoration']] },
  { id: 'jewelry', label: 'Jewellers', filters: [['shop', 'jewelry']] },
  { id: 'travel', label: 'Travel agencies', filters: [['shop', 'travel_agency']] },
  { id: 'school', label: 'Schools & training', filters: [['amenity', 'school'], ['amenity', 'college']] },
  { id: 'childcare', label: 'Nurseries & childcare', filters: [['amenity', 'childcare'], ['amenity', 'kindergarten']] },
  { id: 'cleaning', label: 'Cleaning services', filters: [['shop', 'laundry'], ['shop', 'dry_cleaning'], ['office', 'cleaning']] },
  { id: 'pet', label: 'Pet shops & groomers', filters: [['shop', 'pet'], ['shop', 'pet_grooming']] },
  { id: 'any_shop', label: 'Any shop (all retail)', filters: [['shop', '*']] },
  { id: 'any_office', label: 'Any office / business', filters: [['office', '*']] },
];

/** Lookup by id, used by the query builder. */
export function findBusinessType(id) {
  return BUSINESS_TYPES.find((entry) => entry.id === id) || null;
}
