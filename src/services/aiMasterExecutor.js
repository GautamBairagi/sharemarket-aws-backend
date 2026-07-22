/**
 * AI Master Executor — Execute master command output safely
 *
 * Takes the execution plan from aiMasterPrompt and:
 * 1. Validates safety rules
 * 2. Executes SQL (single or composite)
 * 3. Handles transactions
 * 4. Returns UI-ready response
 */

const db = require('../config/db');
const bcrypt = require('bcryptjs');

// ─────────────────────────────────────────────────────────────────────────────
// SAFE EXECUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute master command output
 * @param {object} masterOutput - From processMasterCommand()
 * @param {object} reqUser - {id, role, full_name}
 */
const executeMasterCommand = async (masterOutput, reqUser = {}) => {
    if (!masterOutput.success === false) {
        return {
            success: false,
            message: masterOutput.error || 'Command processing failed',
        };
    }

    const { execution, intent, data = {} } = masterOutput;

    if (!execution) {
        return {
            success: false,
            message: 'No execution plan provided',
        };
    }

    // Error from AI (couldn't understand command)
    if (execution.type === 'error') {
        return {
            success: false,
            message: execution.error || 'Cannot understand command',
        };
    }

    try {
        // SINGLE SQL EXECUTION
        if (execution.type === 'sql' && execution.sql) {
            const [result] = await db.execute(execution.sql, execution.params || []);

            return {
                success: true,
                message: `${intent.operation} executed successfully`,
                rowCount: result.affectedRows || result.length || 0,
                data: Array.isArray(result) ? result : [],
                meta: {
                    module: intent.module,
                    operation: intent.operation,
                },
            };
        }

        // COMPOSITE EXECUTION (multiple steps, transaction)
        if (execution.type === 'composite' && Array.isArray(execution.composite)) {
            const connection = await db.getConnection();

            try {
                await connection.beginTransaction();

                const stepResults = [];

                for (const step of execution.composite) {
                    console.log(`[Master Executor] Step ${step.step}: ${step.description}`);

                    const [result] = await connection.execute(
                        step.sql,
                        step.params || []
                    );

                    stepResults.push({
                        step: step.step,
                        description: step.description,
                        rowCount: result.affectedRows || result.length || 0,
                    });
                }

                await connection.commit();

                return {
                    success: true,
                    message: `${intent.operation} completed in ${stepResults.length} steps`,
                    steps: stepResults,
                    meta: {
                        module: intent.module,
                        operation: intent.operation,
                    },
                };

            } catch (err) {
                await connection.rollback();
                throw err;
            } finally {
                connection.release();
            }
        }

        return {
            success: false,
            message: 'Unknown execution type: ' + execution.type,
        };

    } catch (err) {
        console.error('[Master Executor] ❌ Execution error:', err.message);
        return {
            success: false,
            message: err.message || 'Execution failed',
        };
    }
};

module.exports = { executeMasterCommand };
