/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 */

/**
 * SUST_Lib_CostAllocation.js
 *
 * GAAP-aware cost allocation engine for Sustana Recovery multi-output processing.
 *
 * Implements three allocation modes:
 *   - WEIGHT (default): uniform $/lb allocation across all outputs by weight.
 *   - BYPRODUCT: residual streams carry at NRV (or zero); the primary
 *     output absorbs the remaining input cost.
 *   - RELATIVE_NRV: Joint-product treatment, pro-rata by NRV across all outputs.
 *
 * NRV is computed via hierarchical fallback:
 *   1. custitem_sust_nrv_per_lb (manual override on item)
 *   2. Index price × typical yield (computed)
 *   3. Item's last sale price (saved-search lookup)
 *   4. Zero
 *
 * Used by:
 *   - SUST_UE_Processing_CreateInvAdj (processing-time allocation)
 *   - SUST_UE_Settlement_CostFlowBack (settlement-time deferred-pricing flow-back)
 *   - SUST_SS_LCNRVTest (period-end NRV testing)
 *
 * Research basis: V2_GAAP_Inventory_Costing_Analysis.pdf — Horngren framework,
 * Southern Copper 10-K, Materion 10-K, ASC 330-10-35-1B (LCNRV), ASU 2015-11.
 *
 * Author: Sustana Dev Team
 * Date: June 2026 (v2.1)
 */

define(['N/search', 'N/log', './SUST_Lib_MarketPrice'],
    function(search, log, marketPriceLib) {

        // Allocation modes (display texts match customlist_sust_alloc_mode)
        const MODE = {
            WEIGHT: 'Weight',
            BYPRODUCT: 'Byproduct',
            RELATIVE_NRV: 'Relative NRV'
        };

        // Classification values (from customlist_sust_cost_alloc_class)
        const CLASS = {
            PRIMARY: 'Primary',
            JOINT: 'Joint',
            BYPRODUCT: 'Byproduct'
        };

        // NRV source labels (for audit trail)
        const NRV_SOURCE = {
            MANUAL: 'Manual (custitem_sust_nrv_per_lb)',
            DERIVED: 'Derived (index price × yield)',
            LAST_SALE: 'Last Sale Price',
            ZERO: 'Zero (no source available)'
        };

        // Staleness threshold for market-derived NRV
        const MARKET_STALE_DAYS = 7;

        /**
         * Main entry — allocate input cost across output lines using selected mode.
         *
         * @param {object} params
         * @param {number} params.inputCost  Total input cost dollars to distribute
         * @param {array}  params.outputLines  Array of {itemId, lbs, classification?, recoveryPct?, marketSourceText?, lotId?}
         * @param {string} params.mode  One of MODE values (default: WEIGHT)
         * @returns {object} {outputLines (mutated with allocated_cost + nrv metadata), summary}
         */
        function allocateInputCost(params) {
            const inputCost = parseFloat(params.inputCost) || 0;
            const outputLines = params.outputLines || [];
            // Weight-proportional is the Sustana default; records pass their mode explicitly.
            const mode = params.mode || MODE.WEIGHT;

            log.audit('Cost Allocation Start',
                `Mode: ${mode}, Input Cost: $${inputCost.toFixed(2)}, Output Lines: ${outputLines.length}`);

            if (outputLines.length === 0) {
                return { outputLines: [], summary: { error: 'No output lines' } };
            }

            // Enrich each line with classification + NRV
            outputLines.forEach(function(line, idx) {
                if (!line.classification) {
                    line.classification = lookupItemClassification(line.itemId);
                }
                const nrvResult = computeNRV(line);
                line.nrvPerLb = nrvResult.nrvPerLb;
                line.nrvTotal = nrvResult.nrvTotal;
                line.nrvSource = nrvResult.source;
                line.nrvStale = nrvResult.stale || false;
                line._index = idx;
            });

            // Dispatch on mode
            let summary;
            if (mode === MODE.BYPRODUCT) {
                summary = allocateByproduct(inputCost, outputLines);
            } else if (mode === MODE.RELATIVE_NRV) {
                summary = allocateRelativeNRV(inputCost, outputLines);
            } else if (mode === MODE.WEIGHT) {
                summary = allocateWeight(inputCost, outputLines);
            } else {
                log.error('Unknown allocation mode', `Mode "${mode}" not recognized — defaulting to WEIGHT`);
                summary = allocateWeight(inputCost, outputLines);
            }

            summary.mode = mode;
            summary.inputCost = inputCost;
            summary.totalAllocated = outputLines.reduce(function(sum, l) { return sum + (l.allocatedCost || 0); }, 0);

            log.audit('Cost Allocation Complete',
                `Mode: ${mode}, Input: $${inputCost.toFixed(2)}, Allocated: $${summary.totalAllocated.toFixed(2)}. ` +
                outputLines.map(function(l) {
                    return `[${l.classification}] ${l.lbs}lb × $${(l.allocatedCost / Math.max(l.lbs, 1)).toFixed(4)}/lb = $${l.allocatedCost.toFixed(2)} (NRV: ${l.nrvSource})`;
                }).join('; '));

            return { outputLines: outputLines, summary: summary };
        }

        /**
         * BYPRODUCT method (Southern Copper precedent):
         *   - Byproducts carry at NRV (capped at full NRV; cannot exceed total available cost)
         *   - Primary/Joint absorb the residual
         *   - Multiple primaries: split residual by relative NRV (or equally if no NRV)
         */
        function allocateByproduct(inputCost, outputLines) {
            const byproducts = outputLines.filter(function(l) { return l.classification === CLASS.BYPRODUCT; });
            const primaries = outputLines.filter(function(l) {
                return l.classification === CLASS.PRIMARY || l.classification === CLASS.JOINT || !l.classification;
            });

            // Byproducts get NRV (or zero if NRV is zero/uncertain)
            let totalByproductCost = 0;
            byproducts.forEach(function(bp) {
                bp.allocatedCost = Math.max(0, bp.nrvTotal || 0);
                totalByproductCost += bp.allocatedCost;
            });

            // Cap byproduct cost at total input — never allocate more than we have
            if (totalByproductCost > inputCost) {
                const scale = inputCost / totalByproductCost;
                byproducts.forEach(function(bp) {
                    bp.allocatedCost = bp.allocatedCost * scale;
                });
                totalByproductCost = inputCost;
            }

            // Primaries absorb the rest
            const residualCost = inputCost - totalByproductCost;
            if (primaries.length === 1) {
                primaries[0].allocatedCost = residualCost;
            } else if (primaries.length > 1) {
                const totalPrimaryNRV = primaries.reduce(function(s, p) { return s + (p.nrvTotal || 0); }, 0);
                if (totalPrimaryNRV > 0) {
                    primaries.forEach(function(p) {
                        p.allocatedCost = residualCost * ((p.nrvTotal || 0) / totalPrimaryNRV);
                    });
                } else {
                    // Fallback: equal split among primaries
                    primaries.forEach(function(p) { p.allocatedCost = residualCost / primaries.length; });
                }
            }

            return {
                method: 'Byproduct',
                byproductCost: totalByproductCost,
                primaryResidual: residualCost,
                primaryCount: primaries.length,
                byproductCount: byproducts.length
            };
        }

        /**
         * RELATIVE_NRV method (joint-product treatment):
         *   All outputs allocated pro-rata by their NRV.
         */
        function allocateRelativeNRV(inputCost, outputLines) {
            const totalNRV = outputLines.reduce(function(s, l) { return s + (l.nrvTotal || 0); }, 0);

            if (totalNRV > 0) {
                outputLines.forEach(function(l) {
                    l.allocatedCost = inputCost * ((l.nrvTotal || 0) / totalNRV);
                });
            } else {
                // Degenerate case: no NRV available → fall back to weight
                log.audit('Relative NRV fallback', 'No NRV available on any line, falling back to weight-proportional');
                return allocateWeight(inputCost, outputLines);
            }

            return {
                method: 'Relative NRV',
                totalNRV: totalNRV
            };
        }

        /**
         * WEIGHT method (legacy v2 Chunk Q behavior):
         *   Uniform $/lb across all outputs regardless of NRV or classification.
         */
        function allocateWeight(inputCost, outputLines) {
            const totalLbs = outputLines.reduce(function(s, l) { return s + (parseFloat(l.lbs) || 0); }, 0);

            if (totalLbs > 0) {
                outputLines.forEach(function(l) {
                    l.allocatedCost = inputCost * ((parseFloat(l.lbs) || 0) / totalLbs);
                });
            } else {
                outputLines.forEach(function(l) { l.allocatedCost = 0; });
            }

            return {
                method: 'Weight-proportional',
                totalLbs: totalLbs,
                ratePerLb: totalLbs > 0 ? inputCost / totalLbs : 0
            };
        }

        /**
         * Compute NRV for a single output line via hierarchical fallback.
         *
         * @param {object} line  {itemId, lbs, marketSourceText?, recoveryPct?}
         * @returns {object} {nrvPerLb, nrvTotal, source, stale}
         */
        function computeNRV(line) {
            const lbs = parseFloat(line.lbs) || 0;
            const itemId = line.itemId;

            if (!itemId) {
                return { nrvPerLb: 0, nrvTotal: 0, source: NRV_SOURCE.ZERO };
            }

            // Source 1: manual override on item
            try {
                const itemLookup = search.lookupFields({
                    type: search.Type.ITEM,
                    id: itemId,
                    columns: ['custitem_sust_nrv_per_lb', 'custitem_sust_market_price_source', 'custitem_sust_typical_recovery']
                });

                const manualNRV = parseFloat(itemLookup.custitem_sust_nrv_per_lb) || 0;
                if (manualNRV > 0) {
                    return {
                        nrvPerLb: manualNRV,
                        nrvTotal: manualNRV * lbs,
                        source: NRV_SOURCE.MANUAL
                    };
                }

                // Source 2: derived (index price × yield)
                const marketSourceRef = line.marketSourceText
                    || (itemLookup.custitem_sust_market_price_source && Array.isArray(itemLookup.custitem_sust_market_price_source) && itemLookup.custitem_sust_market_price_source.length
                            ? itemLookup.custitem_sust_market_price_source[0].text
                            : null);
                if (marketSourceRef) {
                    try {
                        const priceData = marketPriceLib.getLatestPrice(marketSourceRef);
                        if (priceData && priceData.pricePerLb > 0) {
                            const yieldFactor = parseFloat(line.recoveryPct || itemLookup.custitem_sust_typical_recovery) / 100 || 1;
                            const nrvPerLb = priceData.pricePerLb * yieldFactor;

                            // Check staleness
                            const stale = isStale(priceData.date);

                            if (nrvPerLb > 0) {
                                return {
                                    nrvPerLb: nrvPerLb,
                                    nrvTotal: nrvPerLb * lbs,
                                    source: NRV_SOURCE.DERIVED,
                                    stale: stale
                                };
                            }
                        }
                    } catch (priceErr) {
                        log.debug('Market price lookup failed', `Source ${marketSourceRef}: ${priceErr.message}`);
                    }
                }

                // Source 3: last sale price (saved search)
                try {
                    const saleSearch = search.create({
                        type: search.Type.TRANSACTION,
                        filters: [
                            ['type', 'anyof', 'CustInvc'],
                            'AND',
                            ['item', 'anyof', itemId],
                            'AND',
                            ['mainline', 'is', 'F']
                        ],
                        columns: [
                            search.createColumn({ name: 'rate', sort: search.Sort.DESC })
                        ]
                    });
                    const saleResults = saleSearch.run().getRange({ start: 0, end: 1 });
                    if (saleResults.length > 0) {
                        const lastRate = parseFloat(saleResults[0].getValue('rate')) || 0;
                        if (lastRate > 0) {
                            return {
                                nrvPerLb: lastRate,
                                nrvTotal: lastRate * lbs,
                                source: NRV_SOURCE.LAST_SALE
                            };
                        }
                    }
                } catch (saleErr) {
                    log.debug('Last sale price lookup failed', `Item ${itemId}: ${saleErr.message}`);
                }
            } catch (itemErr) {
                log.error('NRV computation error', `Item ${itemId}: ${itemErr.message}`);
            }

            // Source 4: zero
            return { nrvPerLb: 0, nrvTotal: 0, source: NRV_SOURCE.ZERO };
        }

        /**
         * Look up item's cost allocation classification.
         */
        function lookupItemClassification(itemId) {
            if (!itemId) return CLASS.PRIMARY;
            try {
                const itemLookup = search.lookupFields({
                    type: search.Type.ITEM,
                    id: itemId,
                    columns: ['custitem_sust_cost_alloc_class']
                });
                const classField = itemLookup.custitem_sust_cost_alloc_class;
                if (classField && Array.isArray(classField) && classField.length > 0) {
                    return classField[0].text || CLASS.PRIMARY;
                }
                return classField || CLASS.PRIMARY;
            } catch (e) {
                log.debug('Classification lookup failed', `Item ${itemId}, defaulting to Primary: ${e.message}`);
                return CLASS.PRIMARY;
            }
        }

        /**
         * Helper: check if a stored market price date is older than threshold.
         */
        function isStale(dateStored) {
            if (!dateStored) return true;
            try {
                const stored = new Date(dateStored);
                const now = new Date();
                const ageDays = (now - stored) / (1000 * 60 * 60 * 24);
                return ageDays > MARKET_STALE_DAYS;
            } catch (e) {
                return true;
            }
        }

        /**
         * Convenience: format an audit string for human-readable logs / notes.
         */
        function formatAuditString(result) {
            const s = result.summary;
            const lines = result.outputLines.map(function(l) {
                return `  [${l.classification}] ${l.lbs}lb @ $${(l.allocatedCost / Math.max(l.lbs, 1)).toFixed(4)}/lb = $${l.allocatedCost.toFixed(2)} (NRV: ${l.nrvSource}${l.nrvStale ? ', STALE' : ''})`;
            });
            return `Cost Allocation [${s.mode}] Input: $${s.inputCost.toFixed(2)}, Allocated: $${s.totalAllocated.toFixed(2)}\n` + lines.join('\n');
        }

        return {
            allocateInputCost: allocateInputCost,
            computeNRV: computeNRV,
            lookupItemClassification: lookupItemClassification,
            formatAuditString: formatAuditString,
            MODE: MODE,
            CLASS: CLASS,
            NRV_SOURCE: NRV_SOURCE
        };

    });
