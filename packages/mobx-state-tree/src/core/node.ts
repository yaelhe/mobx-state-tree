import { observable, computed, reaction } from "mobx"

let nextNodeId = 1
export interface INode {
    readonly type: IType<any, any>

    readonly storedValue: any
    readonly _environment: any
    readonly path: string
    readonly isRoot: boolean
    readonly parent: INode | null
    readonly root: INode
    subpath: string

    isRunningAction(): boolean
    _isRunningAction: boolean
    isProtectionEnabled: boolean
    isProtected: boolean
    assertWritable(): void

    identifier: string | null

    isAlive: boolean
    assertAlive(): void

    identifierAttribute: string | undefined
    identifierCache: IdentifierCache | undefined

    readonly value: any
    readonly snapshot: any

    resolve(pathParts: string): INode
    resolve(pathParts: string, failIfResolveFails: boolean): INode | undefined
    resolve(path: string, failIfResolveFails?: boolean): INode | undefined

    resolvePath(pathParts: string[]): INode
    resolvePath(pathParts: string[], failIfResolveFails: boolean): INode | undefined
    resolvePath(pathParts: string[], failIfResolveFails?: boolean): INode | undefined

    getRelativePathTo(target: INode): string
    setParent(newParent: INode | null, subpath: string | null): void

    getChildNode(subpath: string): INode
    getChildren(): INode[]
    getChildType(key: string): IType<any, any>
    removeChild(subpath: string): void

    unbox(childNode: INode): any
    detach(): void

    die(): void
    aboutToDie(): void
    finalizeDeath(): void

    emitPatch(basePatch: IReversibleJsonPatch, source: INode): void

    readonly middlewares: IMiddlewareHandler[]

    addMiddleWare(handler: IMiddlewareHandler): IDisposer

    applyPatchLocally(subpath: string, patch: IJsonPatch): void
    onPatch(handler: (patch: IJsonPatch, reversePatch: IJsonPatch) => void): IDisposer
    applyPatches(patches: IJsonPatch[]): void

    applySnapshot(snapshot: any): void
    onSnapshot(onChange: (snapshot: any) => void): IDisposer
    addDisposer(disposer: () => void): void
}

export class ImmutableNode implements INode {
    // optimization: these fields make MST memory expensive for primitives. Most can be initialized lazily, or with EMPTY_ARRAY on prototype
    readonly nodeId = ++nextNodeId
    readonly type: IType<any, any>
    readonly storedValue: any
    @observable protected _parent: INode | null = null
    @observable subpath: string = ""
    _isRunningAction = false // only relevant for root

    identifierCache: IdentifierCache | undefined
    isProtectionEnabled = true
    identifierAttribute: string | undefined = undefined // not to be modified directly, only through model initialization
    _environment: any = undefined
    protected _autoUnbox = true // unboxing is disabled when reading child nodes
    protected _isAlive = true // optimization: use binary flags for all these switches
    protected _isDetaching = false

    middlewares = EMPTY_ARRAY as IMiddlewareHandler[]

    constructor(
        type: IType<any, any>,
        parent: INode | null,
        subpath: string,
        environment: any,
        initialValue: any,
        storedValue: any,
        canAttachTreeNode: boolean,
        finalizeNewInstance: (node: INode, initialValue: any) => void = noop
    ) {
        this.type = type
        this._parent = parent
        this.subpath = subpath
        this.storedValue = storedValue
        this._environment = environment
        this.unbox = this.unbox.bind(this)

        this.preboot()

        if (!parent) this.identifierCache = new IdentifierCache()
        if (canAttachTreeNode) addHiddenFinalProp(this.storedValue, "$treenode", this)

        let sawException = true
        try {
            if (canAttachTreeNode) addHiddenFinalProp(this.storedValue, "toJSON", toJSON)

            this._isRunningAction = true
            finalizeNewInstance(this, initialValue)
            this._isRunningAction = false

            if (parent) parent.root.identifierCache!.addNodeToCache(this)
            else this.identifierCache!.addNodeToCache(this)

            this.fireHook("afterCreate")
            if (parent) this.fireHook("afterAttach")
            sawException = false
        } finally {
            if (sawException) {
                // short-cut to die the instance, to avoid the snapshot computed starting to throw...
                this._isAlive = false
            }
        }
    }

    preboot() {}

    /*
     * Returnes (escaped) path representation as string
     */
    @computed
    public get path(): string {
        if (!this.parent) return ""
        return this.parent.path + "/" + escapeJsonPath(this.subpath)
    }

    public get isRoot(): boolean {
        return this.parent === null
    }

    public get parent(): INode | null {
        return this._parent
    }

    // TODO: make computed
    public get root(): INode {
        // future optimization: store root ref in the node and maintain it
        let p,
            r: INode = this
        while ((p = r.parent)) r = p
        return r as INode
    }

    setParent(newParent: INode | null, subpath: string | null = null) {
        if (this.parent === newParent && this.subpath === subpath) return
        if (newParent) {
            if (this._parent && newParent !== this._parent) {
                fail(
                    `A node cannot exists twice in the state tree. Failed to add ${this} to path '${newParent.path}/${subpath}'.`
                )
            }
            if (!this._parent && newParent.root === this) {
                fail(
                    `A state tree is not allowed to contain itself. Cannot assign ${this} to path '${newParent.path}/${subpath}'`
                )
            }
            if (
                !this._parent &&
                !!this.root._environment &&
                this.root._environment !== newParent.root._environment
            ) {
                fail(
                    `A state tree cannot be made part of another state tree as long as their environments are different.`
                )
            }
        }
        if (this.parent && !newParent) {
            this.die()
        } else {
            this.subpath = subpath || ""
            if (newParent && newParent !== this._parent) {
                newParent.root.identifierCache!.mergeCache(this)
                this._parent = newParent
                this.fireHook("afterAttach")
            }
        }
    }

    // TODO: lift logic outside this file
    getRelativePathTo(target: INode): string {
        // PRE condition target is (a child of) base!
        if (this.root !== target.root)
            fail(
                `Cannot calculate relative path: objects '${this}' and '${target}' are not part of the same object tree`
            )

        const baseParts = splitJsonPath(this.path)
        const targetParts = splitJsonPath(target.path)
        let common = 0
        for (; common < baseParts.length; common++) {
            if (baseParts[common] !== targetParts[common]) break
        }
        // TODO: assert that no targetParts paths are "..", "." or ""!
        return (
            baseParts
                .slice(common)
                .map(_ => "..")
                .join("/") + joinJsonPath(targetParts.slice(common))
        )
    }

    resolve(pathParts: string): INode
    resolve(pathParts: string, failIfResolveFails: boolean): INode | undefined
    resolve(path: string, failIfResolveFails: boolean = true): INode | undefined {
        return this.resolvePath(splitJsonPath(path), failIfResolveFails)
    }

    // TODO: lift logic outside this file
    resolvePath(pathParts: string[]): INode
    resolvePath(pathParts: string[], failIfResolveFails: boolean): INode | undefined
    resolvePath(pathParts: string[], failIfResolveFails: boolean = true): INode | undefined {
        // counter part of getRelativePath
        // note that `../` is not part of the JSON pointer spec, which is actually a prefix format
        // in json pointer: "" = current, "/a", attribute a, "/" is attribute "" etc...
        // so we treat leading ../ apart...
        let current: INode | null = this
        for (let i = 0; i < pathParts.length; i++) {
            if (pathParts[i] === "") current = current!.root
            else if (pathParts[i] === "..") current = current!.parent
            else if (pathParts[i] === "." || pathParts[i] === "")
                // '/bla' or 'a//b' splits to empty strings
                continue
            else if (current) {
                current = current.getChildNode(pathParts[i])
                continue
            }

            if (!current) {
                if (failIfResolveFails)
                    return fail(
                        `Could not resolve '${pathParts[i]}' in '${joinJsonPath(
                            pathParts.slice(0, i - 1)
                        )}', path of the patch does not resolve`
                    )
                else return undefined
            }
        }
        return current!
    }

    fireHook(name: string) {
        const fn =
            this.storedValue && typeof this.storedValue === "object" && this.storedValue[name]
        if (typeof fn === "function") fn.apply(this.storedValue)
    }

    @computed
    public get value(): any {
        if (!this._isAlive) return undefined
        return this.type.getValue(this)
    }

    @computed
    public get snapshot() {
        if (!this._isAlive) return undefined
        // advantage of using computed for a snapshot is that nicely respects transactions etc.
        const snapshot = this.type.getSnapshot(this)
        // avoid any external modification in dev mode
        if (process.env.NODE_ENV !== "production") {
            return freeze(snapshot)
        }
        return snapshot
    }

    isRunningAction(): boolean {
        if (this._isRunningAction) return true
        if (this.isRoot) return false
        return this.parent!.isRunningAction()
    }

    get identifier(): string | null {
        return this.identifierAttribute ? this.storedValue[this.identifierAttribute] : null
    }

    public get isAlive() {
        return this._isAlive
    }

    public assertAlive() {
        if (!this._isAlive)
            fail(
                `${this} cannot be used anymore as it has died; it has been removed from a state tree. If you want to remove an element from a tree and let it live on, use 'detach' or 'clone' the value`
            )
    }

    getChildNode(subpath: string): INode {
        this.assertAlive()
        this._autoUnbox = false
        const res = this.type.getChildNode(this, subpath)
        this._autoUnbox = true
        return res
    }

    getChildren(): INode[] {
        this.assertAlive()
        this._autoUnbox = false
        const res = this.type.getChildren(this)
        this._autoUnbox = true
        return res
    }

    getChildType(key: string): IType<any, any> {
        return this.type.getChildType(key)
    }

    get isProtected(): boolean {
        return this.root.isProtectionEnabled
    }

    assertWritable() {
        this.assertAlive()
        if (!this.isRunningAction() && this.isProtected) {
            fail(
                `Cannot modify '${this}', the object is protected and can only be modified by using an action.`
            )
        }
    }

    removeChild(subpath: string) {
        this.type.removeChild(this, subpath)
    }

    unbox(childNode: INode): any {
        if (childNode && this._autoUnbox === true) return childNode.value
        return childNode
    }

    toString(): string {
        const identifier = this.identifier ? `(id: ${this.identifier})` : ""
        return `${this.type.name}@${this.path || "<root>"}${identifier}${this.isAlive
            ? ""
            : "[dead]"}`
    }

    die() {
        // ImmutableNode never dies! (just detaches)
    }

    emitPatch(basePatch: IReversibleJsonPatch, source: INode) {
        throw fail(`ImmutableNode does not support the emitPatch operation`)
    }

    finalizeDeath() {
        throw fail(`ImmutableNode does not support the finalizeDeath operation`)
    }

    aboutToDie() {
        throw fail(`ImmutableNode does not support the aboutToDie operation`)
    }

    addMiddleWare(handler: IMiddlewareHandler): IDisposer {
        throw fail(`ImmutableNode does not support the addMiddleWare operation`)
    }

    applyPatchLocally(subpath: string, patch: IJsonPatch): void {
        throw fail(`ImmutableNode does not support the applyPatchLocally operation`)
    }

    onPatch(handler: (patch: IJsonPatch, reversePatch: IJsonPatch) => void): IDisposer {
        throw fail(`ImmutableNode does not support the onPatch operation`)
    }

    applyPatches(patches: IJsonPatch[]): void {
        throw fail(`ImmutableNode does not support the applyPatches operation`)
    }

    applySnapshot(snapshot: any): void {
        throw fail(`ImmutableNode does not support the applySnapshot operation`)
    }

    onSnapshot(onChange: (snapshot: any) => void): IDisposer {
        throw fail(`ImmutableNode does not support the onSnapshot operation`)
    }

    detach() {
        if (!this._isAlive) fail(`Error while detaching, node is not alive.`)
        if (this.isRoot) return
        else {
            this.fireHook("beforeDetach")
            this._environment = (this.root as INode)._environment // make backup of environment
            this._isDetaching = true
            this.identifierCache = this.root.identifierCache!.splitCache(this)
            this.parent!.removeChild(this.subpath)
            this._parent = null
            this.subpath = ""
            this._isDetaching = false
        }
    }

    addDisposer(disposer: () => void) {
        throw fail(`ImmutableNode does not support the addDisposer operation`)
    }
}

export class Node extends ImmutableNode implements INode {
    readonly middlewares: IMiddlewareHandler[] = []
    private readonly snapshotSubscribers: ((snapshot: any) => void)[] = []
    // TODO: split patches in two; patch and reversePatch
    private readonly patchSubscribers: ((
        patch: IJsonPatch,
        reversePatch: IJsonPatch
    ) => void)[] = []
    private readonly disposers: (() => void)[] = []
    // applyPatches: (patches: IJsonPatch[]) => void
    // applySnapshot: (snapshot: any) => void

    constructor(
        type: IType<any, any>,
        parent: INode | null,
        subpath: string,
        environment: any,
        initialValue: any,
        storedValue: any,
        canAttachTreeNode: boolean,
        finalizeNewInstance: (node: INode, initialValue: any) => void = noop
    ) {
        super(
            type,
            parent,
            subpath,
            environment,
            initialValue,
            storedValue,
            canAttachTreeNode,
            finalizeNewInstance
        )

        // optimization: don't keep the snapshot by default alive with a reaction by default
        // in prod mode. This saves lot of GC overhead (important for e.g. React Native)
        // if the feature is not actively used
        // downside; no structural sharing if getSnapshot is called incidently
        const snapshotDisposer = reaction(
            () => this.snapshot,
            snapshot => {
                this.emitSnapshot(snapshot)
            }
        )
        snapshotDisposer.onError((e: any) => {
            throw e
        })
        this.addDisposer(snapshotDisposer)
    }

    preboot() {
        // Optimization: this does not need to be done per instance
        // if some pieces from createActionInvoker are extracted
        this.applyPatches = createActionInvoker(
            this.storedValue,
            "@APPLY_PATCHES",
            (patches: IJsonPatch[]) => {
                patches.forEach(patch => {
                    const parts = splitJsonPath(patch.path)
                    const node = this.resolvePath(parts.slice(0, -1))
                    node.applyPatchLocally(parts[parts.length - 1], patch)
                })
            }
        ).bind(this.storedValue)
        this.applySnapshot = createActionInvoker(
            this.storedValue,
            "@APPLY_SNAPSHOT",
            (snapshot: any) => {
                // if the snapshot is the same as the current one, avoid performing a reconcile
                if (snapshot === this.snapshot) return
                // else, apply it by calling the type logic
                return this.type.applySnapshot(this, snapshot)
            }
        ).bind(this.storedValue)
    }

    public die() {
        if (this._isDetaching) return

        if (isStateTreeNode(this.storedValue)) {
            walk(this.storedValue, child => getStateTreeNode(child).aboutToDie())
            walk(this.storedValue, child => getStateTreeNode(child).finalizeDeath())
        }
    }

    public aboutToDie() {
        this.disposers.splice(0).forEach(f => f())
        this.fireHook("beforeDestroy")
    }

    public finalizeDeath() {
        // invariant: not called directly but from "die"
        this.root.identifierCache!.notifyDied(this)
        const self = this
        const oldPath = this.path
        addReadOnlyProp(this, "snapshot", this.snapshot) // kill the computed prop and just store the last snapshot

        this.patchSubscribers.splice(0)
        this.snapshotSubscribers.splice(0)
        this.patchSubscribers.splice(0)
        this._isAlive = false
        this._parent = null
        this.subpath = ""

        // This is quite a hack, once interceptable objects / arrays / maps are extracted from mobx,
        // we could express this in a much nicer way
        // TODO: should be possible to obtain id's still...
        Object.defineProperty(this.storedValue, "$mobx", {
            get() {
                fail(
                    `This object has died and is no longer part of a state tree. It cannot be used anymore. The object (of type '${self
                        .type
                        .name}') used to live at '${oldPath}'. It is possible to access the last snapshot of this object using 'getSnapshot', or to create a fresh copy using 'clone'. If you want to remove an object from the tree without killing it, use 'detach' instead.`
                )
            }
        })
    }

    public onSnapshot(onChange: (snapshot: any) => void): IDisposer {
        return registerEventHandler(this.snapshotSubscribers, onChange)
    }

    public emitSnapshot(snapshot: any) {
        this.snapshotSubscribers.forEach((f: Function) => f(snapshot))
    }

    public onPatch(handler: (patch: IJsonPatch, reversePatch: IJsonPatch) => void): IDisposer {
        return registerEventHandler(this.patchSubscribers, handler)
    }

    emitPatch(basePatch: IReversibleJsonPatch, source: INode) {
        if (this.patchSubscribers.length) {
            const localizedPatch: IReversibleJsonPatch = extend({}, basePatch, {
                path: source.path.substr(this.path.length) + "/" + basePatch.path // calculate the relative path of the patch
            })
            const [patch, reversePatch] = splitPatch(localizedPatch)
            this.patchSubscribers.forEach(f => f(patch, reversePatch))
        }
        if (this.parent) this.parent.emitPatch(basePatch, source)
    }

    addDisposer(disposer: () => void) {
        this.disposers.unshift(disposer)
    }

    addMiddleWare(handler: IMiddlewareHandler) {
        return registerEventHandler(this.middlewares, handler)
    }

    applyPatchLocally(subpath: string, patch: IJsonPatch): void {
        this.assertWritable()
        this.type.applyPatchLocally(this, subpath, patch)
    }
}

export function isNode(value: any): value is INode {
    return value instanceof Node || value instanceof ImmutableNode
}

export type IStateTreeNode = {
    readonly $treenode?: any
}

/**
 * Returns true if the given value is a node in a state tree.
 * More precisely, that is, if the value is an instance of a
 * `types.model`, `types.array` or `types.map`.
 *
 * @export
 * @param {*} value
 * @returns {value is IStateTreeNode}
 */
export function isStateTreeNode(value: any): value is IStateTreeNode {
    return !!(value && value.$treenode)
}

export function getStateTreeNode(value: IStateTreeNode): INode {
    if (isStateTreeNode(value)) return value.$treenode!
    else return fail(`Value ${value} is no MST Node`)
}

function canAttachNode(value: any) {
    return (
        value &&
        typeof value === "object" &&
        !(value instanceof Date) &&
        !isStateTreeNode(value) &&
        !Object.isFrozen(value)
    )
}

function toJSON(this: IStateTreeNode) {
    return getStateTreeNode(this).snapshot
}

export function createNode<S, T>(
    type: IType<S, T>,
    parent: INode | null,
    subpath: string,
    environment: any,
    initialValue: any,
    createNewInstance: (initialValue: any) => T = identity,
    finalizeNewInstance: (node: INode, initialValue: any) => void = noop
) {
    if (isStateTreeNode(initialValue)) {
        const targetNode = getStateTreeNode(initialValue)
        if (!targetNode.isRoot)
            fail(
                `Cannot add an object to a state tree if it is already part of the same or another state tree. Tried to assign an object to '${parent
                    ? parent.path
                    : ""}/${subpath}', but it lives already at '${targetNode.path}'`
            )
        targetNode.setParent(parent, subpath)
        return targetNode
    }

    const storedValue = createNewInstance(initialValue)
    const canAttachTreeNode = canAttachNode(storedValue)

    if (canAttachTreeNode) {
        // tslint:disable-next-line:no_unused-variable
        return new Node(
            type,
            parent,
            subpath,
            environment,
            initialValue,
            storedValue,
            canAttachTreeNode,
            finalizeNewInstance
        )
    }
    return new ImmutableNode(
        type,
        parent,
        subpath,
        environment,
        initialValue,
        storedValue,
        canAttachTreeNode,
        finalizeNewInstance
    )
}

import { IType } from "../types/type"
import {
    escapeJsonPath,
    splitJsonPath,
    joinJsonPath,
    IReversibleJsonPatch,
    stripPatch,
    IJsonPatch,
    splitPatch
} from "./json-patch"
import { walk } from "./mst-operations"
import { IMiddlewareHandler, createActionInvoker } from "./action"
import {
    addReadOnlyProp,
    addHiddenFinalProp,
    extend,
    fail,
    IDisposer,
    registerEventHandler,
    identity,
    noop,
    freeze,
    EMPTY_ARRAY
} from "../utils"
import { IdentifierCache } from "./identifier-cache"
