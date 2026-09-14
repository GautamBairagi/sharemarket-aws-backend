const db = require('../config/db');

/**
 * Returns role-based banned scrip status sets for a user:
 * - hideSet: Set of symbols that MUST BE COMPLETELY HIDDEN for this user.
 * - markSet: Set of symbols that SHOULD BE SHOWN with isBanned: true (for Creator Admin / SuperAdmin to view and unban).
 */
async function getUserBannedScripsStatus(userId, userRole) {
    try {
        const hideSet = new Set();
        const markSet = new Set();

        if (!userId) {
            return { hideSet, markSet };
        }

        // 1. Resolve hierarchy IDs (SuperAdmin IDs and Parent Admin ID)
        const [superAdminRows] = await db.execute("SELECT id FROM users WHERE role = 'SUPERADMIN'");
        const superAdminIds = new Set(superAdminRows.map(u => u.id));

        let parentAdminId = null;

        if (userRole === 'ADMIN') {
            parentAdminId = userId;
        } else if (userRole === 'BROKER') {
            const [bRows] = await db.execute("SELECT parent_id FROM users WHERE id = ?", [userId]);
            if (bRows.length && bRows[0].parent_id) {
                const pid = bRows[0].parent_id;
                // Check if parent is Admin or SuperAdmin
                const [pRows] = await db.execute("SELECT id, role, parent_id FROM users WHERE id = ?", [pid]);
                if (pRows.length) {
                    if (pRows[0].role === 'ADMIN') parentAdminId = pRows[0].id;
                    else if (pRows[0].role === 'SUPERADMIN') superAdminIds.add(pRows[0].id);
                }
            }
        } else if (userRole === 'TRADER' || userRole === 'CLIENT') {
            // Find parent admin via parent_id or client_settings.broker_id
            const [uRows] = await db.execute(`
                SELECT u.parent_id, cs.broker_id 
                FROM users u 
                LEFT JOIN client_settings cs ON u.id = cs.user_id 
                WHERE u.id = ?
            `, [userId]);

            if (uRows.length) {
                const { parent_id, broker_id } = uRows[0];
                const directParent = parent_id || broker_id;

                if (directParent) {
                    const [pRows] = await db.execute("SELECT id, role, parent_id FROM users WHERE id = ?", [directParent]);
                    if (pRows.length) {
                        if (pRows[0].role === 'ADMIN') {
                            parentAdminId = pRows[0].id;
                        } else if (pRows[0].role === 'BROKER' && pRows[0].parent_id) {
                            const [gpRows] = await db.execute("SELECT id, role FROM users WHERE id = ?", [pRows[0].parent_id]);
                            if (gpRows.length && gpRows[0].role === 'ADMIN') {
                                parentAdminId = gpRows[0].id;
                            }
                        }
                    }
                }
            }
        }

        // 2. Fetch all banned scrips
        const [bannedRows] = await db.execute("SELECT symbol, created_by FROM banned_scrips");

        for (const row of bannedRows) {
            const symbol = row.symbol;
            const creatorId = row.created_by;

            const isCreatedBySuperAdmin = superAdminIds.has(creatorId);
            const isCreatedByMyAdmin = parentAdminId && creatorId === parentAdminId;
            const isCreatedByMe = creatorId === userId;

            if (userRole === 'SUPERADMIN') {
                // SuperAdmin sees all banned scrips in markSet so they can view/unban them
                markSet.add(symbol);
            } else if (userRole === 'ADMIN') {
                if (isCreatedByMe) {
                    // Admin sees scrips banned by themselves in markSet (with Banned status)
                    markSet.add(symbol);
                } else if (isCreatedBySuperAdmin) {
                    // Scrips banned by SuperAdmin are hidden for Admin
                    hideSet.add(symbol);
                }
            } else {
                // Broker / Trader / Client:
                // Scrips banned by SuperAdmin or by their parent Admin must be hidden completely
                if (isCreatedBySuperAdmin || isCreatedByMyAdmin) {
                    hideSet.add(symbol);
                }
            }
        }

        return { hideSet, markSet };
    } catch (err) {
        console.error('[getUserBannedScripsStatus] Error:', err);
        return { hideSet: new Set(), markSet: new Set() };
    }
}

/**
 * Checks if a specific symbol is banned for order placement for a given user.
 */
async function isScripBannedForUser(symbol, userId, userRole) {
    try {
        const { hideSet, markSet } = await getUserBannedScripsStatus(userId, userRole);
        const cleanSym = symbol.includes(':') ? symbol.split(':')[1] : symbol;

        for (const s of hideSet) {
            const cleanS = s.includes(':') ? s.split(':')[1] : s;
            if (s === symbol || cleanS === cleanSym) return true;
        }

        for (const s of markSet) {
            const cleanS = s.includes(':') ? s.split(':')[1] : s;
            if (s === symbol || cleanS === cleanSym) return true;
        }

        return false;
    } catch (err) {
        console.error('[isScripBannedForUser] Error:', err);
        return false;
    }
}


/**
 * Utility to check if a candidate symbol matches any item in hideSet
 */
function checkSymbolHidden(sym, hideSet) {
    if (!sym || !hideSet || hideSet.size === 0) return false;
    const cleanSym = sym.includes(':') ? sym.split(':')[1] : sym;
    const normSym = cleanSym.replace(/[^A-Z0-9]/gi, '').toUpperCase();

    for (const h of hideSet) {
        const cleanH = h.includes(':') ? h.split(':')[1] : h;
        const normH = cleanH.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (h === sym || cleanH === cleanSym || (normH && normH === normSym)) return true;
    }
    return false;
}

/**
 * Utility to check if a candidate symbol matches any item in markSet
 */
function checkSymbolMarked(sym, markSet) {
    if (!sym || !markSet || markSet.size === 0) return false;
    const cleanSym = sym.includes(':') ? sym.split(':')[1] : sym;
    const normSym = cleanSym.replace(/[^A-Z0-9]/gi, '').toUpperCase();

    for (const m of markSet) {
        const cleanM = m.includes(':') ? m.split(':')[1] : m;
        const normM = cleanM.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (m === sym || cleanM === cleanSym || (normM && normM === normSym)) return true;
    }
    return false;
}

module.exports = {
    getUserBannedScripsStatus,
    isScripBannedForUser,
    checkSymbolHidden,
    checkSymbolMarked
};

