'use strict';
const { columns } = require('./column-rename');

function unusedColumns(text, layouts) {
  // An incomplete layout or dynamic Fields(...) lookup cannot prove non-use.
  if (!layouts.length || layouts.some(layout => !layout || layout.hasDynamicFieldAccess)) return [];
  const datasets = layouts.map(layout => {
    const names = Object.keys(layout.datasets);
    return names.find(name => name.toLowerCase() === 'dataset_result') || (names.length === 1 ? names[0] : undefined);
  });
  if (datasets.some(dataset => !dataset)) return [];
  return columns(text).filter(column => {
    // Match the actual generated field name. Wait for a build if there is no
    // corresponding definition, rather than guessing compiler name conversion.
    const defined = layouts.some((layout, index) => layout.datasets[datasets[index]].some(field => field.name === column.name));
    const used = layouts.some((layout, index) => layout.references.some(ref => ref.name === column.name && ref.datasets.includes(datasets[index])));
    return defined && !used;
  });
}
module.exports = { unusedColumns };
