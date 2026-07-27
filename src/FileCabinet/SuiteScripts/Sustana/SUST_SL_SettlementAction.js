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

define(['N/record', 'N/redirect', 'N/log'],
    function(record, redirect, log) {

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
