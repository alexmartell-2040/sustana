/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */

/**
 * SUST_RL_SeedDemo.js
 *
 * Programmatic (API) trigger for the Sustana demo-data seeder. A GET or POST runs
 * SUST_SL_SeedSustanaDemo.runSeedAll() — the exact same idempotent seed logic the
 * Suitelet uses, all groups — and returns the JSON summary. This lets the demo data
 * be (re)inserted headlessly via a Token-Based-Auth REST call, with no UI clicks.
 *
 * Auth: Token-Based Authentication (OAuth 1.0). Requires an Integration record +
 * Access Token whose role can run RESTlets and create the demo records. The seeder
 * is idempotent, so repeated calls update rather than duplicate.
 *
 * Author: MHI
 * Date: July 2026
 */

define(['./SUST_SL_SeedSustanaDemo', 'N/log'],
    function(seeder, log) {

        function run(context) {
            try {
                log.audit('SUST_RL_SeedDemo', 'Seed invoked via RESTlet');
                const result = seeder.runSeedAll();
                log.audit('SUST_RL_SeedDemo',
                    result && result.ok ? 'Seed complete' : ('Seed failed: ' + (result && result.error)));
                return result;
            } catch (e) {
                log.error('SUST_RL_SeedDemo failed', e.toString() + '\n' + (e.stack || ''));
                return { ok: false, error: e.message };
            }
        }

        // GET and POST both run the full seed. GET is handy for a quick browser/curl
        // check; POST ignores its body (the seed always runs all groups).
        return { get: run, post: run };
    });
