/**
 * Binary min-heap with a total tie-break, shared by every planner.
 *
 * ## Why it lives here rather than inside `astar.ts`
 *
 * The 2-D A* already had one. Stage F needed a second planner for the volumetric
 * manifold, and the tempting move was to copy it — which is how two implementations of
 * a tie-break drift apart, and a tie-break is precisely the thing that must not drift.
 * The project's boundary test `no-render-imports.test.ts` exists for the same reason at
 * a larger scale: one implementation, imported by both callers.
 *
 * ## The tie-break is the load-bearing part
 *
 * `less` compares keys, and on equality falls through to comparing **items**. That makes
 * the heap a total order on (key, item), so pop order cannot depend on insertion order
 * or on heap layout. Without the item comparison, two cells with equal `f` would emerge
 * in whatever order they were pushed, which on a grid with symmetric costs is common —
 * and the resulting path would depend on the order bids were collected in, which is
 * config order.
 *
 * Cost of the guarantee: nothing. Item comparison is an integer compare on a path that
 * is already doing float compares and array indexing.
 */

export class MinHeap {
  private readonly items: Int32Array
  private readonly keys: Float64Array
  private size = 0

  constructor(capacity: number) {
    this.items = new Int32Array(capacity)
    this.keys = new Float64Array(capacity)
  }

  get length(): number {
    return this.size
  }

  push(item: number, key: number): void {
    if (this.size >= this.items.length) {
      throw new Error('MinHeap overflow: capacity must exceed the reachable cell count')
    }
    let i = this.size++
    this.items[i] = item
    this.keys[i] = key
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.less(i, parent)) {
        this.swap(i, parent)
        i = parent
      } else break
    }
  }

  pop(): number {
    const top = this.items[0]!
    this.size--
    if (this.size > 0) {
      this.items[0] = this.items[this.size]!
      this.keys[0] = this.keys[this.size]!
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let smallest = i
        if (l < this.size && this.less(l, smallest)) smallest = l
        if (r < this.size && this.less(r, smallest)) smallest = r
        if (smallest === i) break
        this.swap(i, smallest)
        i = smallest
      }
    }
    return top
  }

  private less(a: number, b: number): boolean {
    const ka = this.keys[a]!
    const kb = this.keys[b]!
    if (ka < kb) return true
    if (ka > kb) return false
    // Total order on item index — see the class note.
    return this.items[a]! < this.items[b]!
  }

  private swap(a: number, b: number): void {
    const ti = this.items[a]!
    this.items[a] = this.items[b]!
    this.items[b] = ti
    const tk = this.keys[a]!
    this.keys[a] = this.keys[b]!
    this.keys[b] = tk
  }
}