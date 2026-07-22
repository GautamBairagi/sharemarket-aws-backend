
function testExecutionPrice(price, order_type, currentPrice) {
    const executionPrice = price ? parseFloat(price) : (order_type === 'MARKET' ? currentPrice : 0);
    return executionPrice;
}

const mockCurrentPrice = 100;

console.log("Test Case 1: Manual Price (12) for MARKET Order");
console.log("Expected: 12, Actual:", testExecutionPrice("12", "MARKET", mockCurrentPrice));

console.log("\nTest Case 2: No Price for MARKET Order");
console.log("Expected: 100, Actual:", testExecutionPrice(null, "MARKET", mockCurrentPrice));

console.log("\nTest Case 3: Manual Price (150) for LIMIT Order");
console.log("Expected: 150, Actual:", testExecutionPrice("150", "LIMIT", mockCurrentPrice));

console.log("\nTest Case 4: Zero Price for MARKET Order (Should use currentPrice)");
console.log("Expected: 100, Actual:", testExecutionPrice(0, "MARKET", mockCurrentPrice));
