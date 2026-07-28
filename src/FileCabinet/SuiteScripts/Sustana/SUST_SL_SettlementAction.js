/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */

/**
 * SUST_SL_SettlementAction.js
 *
 * One-click settlement lifecycle actions, launched from buttons on the
 * settlement record (rendered by SUST_UE_SettlementModeLock). Performs the
 * same record edit a user would make by hand — record.load + set + save — so
 * every existing guard and side effect still fires:
 *   - ModeLock beforeSubmit (SETTLE-012 Price Fixed gate)
 *   - StatusChange afterSubmit (approval stamp, provisional/final vendor bills)
 *
 * GET params:
 *   settle  = settlement internal id (required)
 *   action  = approve | provisional | fixprice | finalize
 *
 * Success redirects back to the settlement record. A blocked transition
 * (e.g. Final Settled with Price Fixed unchecked) renders the guard's own
 * message with a link back — the demo beat survives, one click instead of
 * edit-and-save.
 *
 * Author: MHI
 * Date: July 2026
 */

define(['N/record', 'N/search', 'N/redirect', 'N/log'],
    function(record, search, redirect, log) {

        const SETTLE_TYPE = 'customrecord_sust_settlement_record';

        const ACTIONS = {
            approve: {
                label: 'Approve & Complete',
                from: ['Draft'],
                apply: function(rec) {
                    rec.setText({ fieldId: 'custrecord_sust_settlement_status', text: 'Completed' });
                }
            },
            provisional: {
                label: 'Mark Provisional Paid',
                from: ['Completed'],
                apply: function(rec) {
                    rec.setText({ fieldId: 'custrecord_sust_settlement_status', text: 'Provisional Paid' });
                }
            },
            rebuild: {
                label: 'Rebuild Totals from Slices',
                from: ['Draft', 'Completed'],
                apply: function(rec) {
                    // Recompute the header from what the settlement actually
                    // contains: slice children (weights + schedule-priced values)
                    // and penalty-detail rows. Fixes stale headers on aggregated
                    // settlements that accumulated edits/regrades over time.
                    const id = rec.id;
                    let gross = 0, net = 0, value = 0, slices = 0;
                    search.create({
                        type: 'customrecord_sust_settle_slice',
                        filters: [['custrecord_sust_slice_settlement', 'anyof', id]],
                        columns: ['custrecord_sust_slice_gross_lbs', 'custrecord_sust_slice_net_lbs', 'custrecord_sust_slice_value']
                    }).run().each(function(r) {
                        gross += parseFloat(r.getValue('custrecord_sust_slice_gross_lbs')) || 0;
                        net += parseFloat(r.getValue('custrecord_sust_slice_net_lbs')) || 0;
                        value += parseFloat(r.getValue('custrecord_sust_slice_value')) || 0;
                        slices++;
                        return true;
                    });
                    if (!slices) throw new Error('This settlement has no receipt slices to rebuild from.');

                    let penalties = 0;
                    search.create({
                        type: 'customrecord_sust_penalty_detail',
                        filters: [['custrecord_sust_penalty_settlement', 'anyof', id]],
                        columns: ['custrecord_sust_penalty_detail_amount']
                    }).run().each(function(r) {
                        penalties += parseFloat(r.getValue('custrecord_sust_penalty_detail_amount')) || 0;
                        return true;
                    });

                    const treatment = parseFloat(rec.getValue({ fieldId: 'custrecord_sust_settlement_treatment' })) || 0;
                    const provisional = parseFloat(rec.getValue({ fieldId: 'custrecord_sust_settlement_provisional' })) || 0;
                    const netValue = value - penalties - treatment;

                    rec.setValue({ fieldId: 'custrecord_sust_settlement_gross_lbs', value: gross });
                    rec.setValue({ fieldId: 'custrecord_sust_settlement_net_lbs', value: net });
                    rec.setValue({ fieldId: 'custrecord_sust_settlement_recovery_pct', value: gross > 0 ? (net / gross) * 100 : 100 });
                    rec.setValue({ fieldId: 'custrecord_sust_settlement_gross_value', value: value });
                    rec.setValue({ fieldId: 'custrecord_sust_settlement_penalties', value: penalties });
                    rec.setValue({ fieldId: 'custrecord_sust_settlement_net_value', value: netValue });
                    rec.setValue({ fieldId: 'custrecord_sust_settlement_balance_due', value: netValue - provisional });
                    const notes = rec.getValue({ fieldId: 'custrecord_sust_settlement_notes' }) || '';
                    rec.setValue({
                        fieldId: 'custrecord_sust_settlement_notes',
                        value: (notes + '\n[REBUILD ' + new Date().toISOString().substring(0, 16).replace('T', ' ')
                            + ' UTC] Header recomputed from ' + slices + ' slices: gross value $' + value.toFixed(2)
                            + ' - penalties $' + penalties.toFixed(2) + ' - treatment $' + treatment.toFixed(2)
                            + ' = net $' + netValue.toFixed(2) + '.').substring(0, 3900)
                    });
                }
            },
            fixprice: {
                label: 'Mark Price Fixed',
                from: null, // any status
                apply: function(rec) {
                    rec.setValue({ fieldId: 'custrecord_sust_settlement_price_fixed', value: true });
                }
            },
            finalize: {
                label: 'Final Settle (Create AP Bill)',
                from: ['Completed', 'Provisional Paid'],
                apply: function(rec) {
                    rec.setText({ fieldId: 'custrecord_sust_settlement_status', text: 'Final Settled' });
                }
            }
        };

        function onRequest(context) {
            const params = context.request.parameters;
            const settleId = parseInt(params.settle, 10);
            const action = ACTIONS[params.action];

            if (!settleId || !action) {
                context.response.write(page('Invalid request',
                    'Missing or unknown settlement/action parameter.', null));
                return;
            }

            try {
                const rec = record.load({ type: SETTLE_TYPE, id: settleId });
                const statusText = (rec.getText({ fieldId: 'custrecord_sust_settlement_status' }) || '').trim();

                if (action.from && action.from.indexOf(statusText) === -1) {
                    context.response.write(page('Action not available',
                        '"' + action.label + '" expects status ' + action.from.join(' or ')
                        + ', but this settlement is currently <b>' + esc(statusText || '(unset)') + '</b>.'
                        + ' Refresh the record and use the buttons offered for its current status.', settleId));
                    return;
                }

                action.apply(rec);
                rec.save(); // guards + status-change side effects fire here

                log.audit('Settlement Action', action.label + ' on settlement ' + settleId
                    + ' (was ' + statusText + ')');
                redirect.toRecord({ type: SETTLE_TYPE, id: settleId });

            } catch (e) {
                // Guard rejections (e.g. PRICE_NOT_FIXED) land here — show the
                // guard's own message, don't bury it in the script log.
                log.audit('Settlement Action blocked', params.action + ' on ' + settleId + ': ' + e.message);
                context.response.write(page('&#9888; ' + action.label + ' was blocked',
                    esc(e.message || String(e)), settleId));
            }
        }

        function page(title, bodyHtml, settleId) {
            const back = settleId
                ? '<a href="/app/common/custom/custrecordentry.nl?rectype=&id=' + settleId + '" '
                  + 'onclick="history.back();return false;" '
                  + 'style="display:inline-block;margin-top:14px;padding:8px 16px;background:#2976F3;color:#fff;'
                  + 'text-decoration:none;border-radius:4px;font-weight:600;">&#8592; Back to Settlement</a>'
                : '';
            return '<html><body style="font-family:Arial,sans-serif;max-width:640px;margin:60px auto;color:#111827;">'
                + '<div style="border:2px solid #dc2626;background:#fef2f2;border-radius:8px;padding:20px 24px;">'
                + '<h2 style="margin:0 0 10px;color:#991b1b;font-size:18px;">' + title + '</h2>'
                + '<div style="font-size:14px;line-height:1.6;">' + bodyHtml + '</div>'
                + back
                + '</div></body></html>';
        }

        function esc(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        }

        return { onRequest: onRequest };
    });
