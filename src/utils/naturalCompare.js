// Real, explicit fix following an explicit report that insisted a real
// bug still existed after tableManagementController.js's own fix had
// already shipped - and a full audit proved that report right: this
// exact comparator lived ONLY in that one file, duplicated nowhere,
// while tableReceiptController.js's own table-label sort had never
// been touched at all and was still doing a plain a.localeCompare(b)
// with no numeric option - the identical "Table 10 sorts before Table
// 2" bug, just in a second, separate place nobody had checked. A
// shared function now, so there is exactly one implementation to ever
// fix, not two that can quietly drift apart again.
function naturalCompare(a, b) {
  const numA = a.match(/\d+/);
  const numB = b.match(/\d+/);
  if (numA && numB) {
    const diff = Number(numA[0]) - Number(numB[0]);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

module.exports = { naturalCompare };
