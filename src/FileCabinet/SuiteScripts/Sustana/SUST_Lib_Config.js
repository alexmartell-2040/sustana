/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 */

/**
 * SUST_Lib_Config.js
 *
 * Cached reader for the single Sustana Config record (customrecord_sust_config).
 * All account-specific internal IDs (subsidiaries, GL accounts, fee item,
 * default location) live on that record — no script hardcodes an internal ID.
 *
 * Pattern per consuming script:
 *   const value = scriptParamValue || Config.get('invAdjAccount');
 * (script parameters, where present, override the config record).
 *
 * The demo seeder (SUST_SL_SeedSustanaDemo) creates and fills the config record,
 * so a fresh deploy + one seeder run is fully wired.
 *
 * Author: MHI
 * Date: July 2026
 */

define(['N/search', 'N/record', 'N/log'], function(search, record, log) {

    const RECORD_TYPE = 'customrecord_sust_config';

    // friendly key -> field id
    const FIELDS = {
        usSubsidiary: 'custrecord_sustcfg_us_sub',
        caSubsidiary: 'custrecord_sustcfg_ca_sub',
        invAdjAccount: 'custrecord_sustcfg_invadj_account',
        settlementExpenseAccount: 'custrecord_sustcfg_settle_exp_acct',
        settlementFeeItem: 'custrecord_sustcfg_settle_fee_item',
        defaultLocation: 'custrecord_sustcfg_default_location'
    };

    let _cache = null; // module-scope cache lives for the script execution

    /**
     * Load the first active config record. Returns {} when none exists —
     * consumers must handle a missing value (log-and-skip, or fail with a
     * clear message), never assume a fallback ID.
     * @returns {Object} map of friendly key -> value (string internal id or '')
     */
    function getConfig() {
        if (_cache) return _cache;
        _cache = {};
        try {
            const s = search.create({
                type: RECORD_TYPE,
                filters: [
                    ['custrecord_sustcfg_active', 'is', 'T'],
                    'AND',
                    ['isinactive', 'is', 'F']
                ],
                columns: ['internalid']
            });
            const res = s.run().getRange({ start: 0, end: 1 });
            if (res.length === 0) {
                log.audit('SUST Config missing',
                    'No active customrecord_sust_config record found. Run SUST_SL_SeedSustanaDemo or create one manually.');
                return _cache;
            }
            const configId = res[0].id;
            // record.load (not lookupFields) so restricted-searchlevel fields still read
            const rec = record.load({ type: RECORD_TYPE, id: configId });
            _cache._id = configId;
            Object.keys(FIELDS).forEach(function(key) {
                _cache[key] = rec.getValue({ fieldId: FIELDS[key] }) || '';
            });
        } catch (e) {
            log.error('SUST_Lib_Config.getConfig', e.message);
        }
        return _cache;
    }

    /**
     * Get one config value by friendly key (see FIELDS).
     * @param {string} key
     * @returns {string} internal id as string, or '' when unset/missing
     */
    function get(key) {
        const cfg = getConfig();
        return cfg[key] || '';
    }

    /** Internal id of the config record itself ('' when none). */
    function getConfigId() {
        const cfg = getConfig();
        return cfg._id || '';
    }

    /** Test/long-running-script helper: drop the cache. */
    function reset() {
        _cache = null;
    }

    return {
        RECORD_TYPE: RECORD_TYPE,
        FIELDS: FIELDS,
        getConfig: getConfig,
        get: get,
        getConfigId: getConfigId,
        reset: reset
    };

});
