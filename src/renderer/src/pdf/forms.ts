import type { PDFDocumentProxy } from './pdfjs'
import { type FieldAnnot, type PageLeaf, uid } from './types'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Scan every page for AcroForm widget annotations and turn them into editable
 * field overlays. Order follows page order, then top-to-bottom, left-to-right,
 * which drives Tab navigation.
 */
export async function detectFields(doc: PDFDocumentProxy, leaves: PageLeaf[]): Promise<FieldAnnot[]> {
  const fields: FieldAnnot[] = []
  let order = 0
  for (const leaf of leaves) {
    const page = await doc.getPage(leaf.srcPage)
    const anns = (await page.getAnnotations({ intent: 'display' })) as any[]
    // Mirror of what pdf.js leaves off the canvas in ENABLE_FORMS mode (see
    // FORM_ANNOT_MODE): it keeps painting push buttons, signatures, read-only
    // fields and locked widgets itself (`hasOwnCanvas` / `noHTML`). Those must
    // stay out of the overlay or their value is drawn twice.
    const widgets = anns.filter(
      (a) =>
        a.subtype === 'Widget' &&
        a.fieldType &&
        a.fieldType !== 'Sig' &&
        !a.pushButton &&
        !a.hidden &&
        !a.hasOwnCanvas &&
        !a.noHTML
    )
    widgets.sort((a, b) => {
      const ay = a.rect[3]
      const by = b.rect[3]
      if (Math.abs(by - ay) > 6) return by - ay
      return a.rect[0] - b.rect[0]
    })
    for (const w of widgets) {
      const rect = w.rect as number[]
      const a = { x: Math.min(rect[0], rect[2]), y: Math.min(rect[1], rect[3]) }
      const b = { x: Math.max(rect[0], rect[2]), y: Math.max(rect[1], rect[3]) }
      let fieldKind: FieldAnnot['fieldKind'] = 'text'
      let value = ''
      let exportValue: string | undefined
      let options: { value: string; label: string }[] | undefined
      const daSize = w.defaultAppearanceData?.fontSize

      if (w.fieldType === 'Tx') {
        fieldKind = 'text'
        value = typeof w.fieldValue === 'string' ? w.fieldValue : ''
      } else if (w.fieldType === 'Btn') {
        const on = w.exportValue ?? w.buttonValue ?? 'On'
        if (w.radioButton) {
          fieldKind = 'radio'
          exportValue = on
          value = w.fieldValue && w.fieldValue !== 'Off' ? w.fieldValue : ''
        } else if (w.checkBox) {
          fieldKind = 'checkbox'
          exportValue = on
          value = w.fieldValue && w.fieldValue !== 'Off' ? on : ''
        } else {
          continue
        }
      } else if (w.fieldType === 'Ch') {
        fieldKind = w.combo ? 'combo' : 'list'
        value = typeof w.fieldValue === 'string' ? w.fieldValue : Array.isArray(w.fieldValue) ? w.fieldValue[0] || '' : ''
        if (Array.isArray(w.options)) {
          options = w.options.map((o: any) => ({
            value: o.exportValue ?? o.displayValue ?? '',
            label: o.displayValue ?? o.exportValue ?? ''
          }))
        }
      } else {
        continue
      }

      fields.push({
        id: uid(),
        leafId: leaf.id,
        type: 'field',
        fieldKind,
        fieldName: w.fieldName || 'field_' + order,
        a,
        b,
        value,
        exportValue,
        multiline: !!w.multiLine,
        maxLen: typeof w.maxLen === 'number' && w.maxLen > 0 ? w.maxLen : undefined,
        options,
        // pdf.js parses the widget's /DA into defaultAppearanceData — there is no
        // top-level `fontSize`, and reading one meant every field silently fell
        // back to auto-sizing. 0 there is the PDF's "auto", which we keep as undefined.
        fontSize: typeof daSize === 'number' && daSize > 0 ? daSize : undefined,
        order: order++
      })
    }
  }
  return fields
}
