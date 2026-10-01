/* Which customers have a dashboard spec.
 *
 * Listing a slug here is what makes the dashboards fetch /specs/customers/<slug>.js. A customer
 * who is not listed costs no request, logs no 404, and renders the base design untouched — which
 * is the point: customisation is opt-in per customer and invisible to everyone else.
 *
 * This file is also the answer to "which dashboards have we customised?" — keep it the only place
 * that needs reading to know.
 */
AkoreSpec.setManifest([
  // 'fiacsa',
]);
