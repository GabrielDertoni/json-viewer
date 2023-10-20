const EventKind = {
    START_OBJ:   0,
    END_OBJ:     1,
    START_ARRAY: 2,
    END_ARRAY:   3,
    TRUE:        4,
    FALSE:       5,
    NULL:        6,
    STRING:      7,
    KEY:         8,

    ERROR:      -1,
};

const ParseVerbatimResult = {
    OK:      0,
    Err:     1,
    Partial: 2,
};

const NestKind = {
    OBJECT: false,
    ARRAY: true,
}

const EVENT_POOL = {
    // Preallocated
    START_OBJ:   { kind: EventKind.START_OBJ   },
    END_OBJ:     { kind: EventKind.END_OBJ     },
    START_ARRAY: { kind: EventKind.START_ARRAY },
    END_ARRAY:   { kind: EventKind.END_ARRAY   },
    TRUE:        { kind: EventKind.TRUE        },
    FALSE:       { kind: EventKind.FALSE       },
    NULL:        { kind: EventKind.NULL        },
    ERROR:       { kind: EventKind.ERROR       },

    clean: false,
    objs: [],

    alloc() {
        if (this.objs.length === 0)
            return { kind: EventKind.ERROR, content: null };
        else
            return this.objs.pop();
    },

    free(obj) {
        if (this.clean) {
            obj.kind = EventKind.ERROR;
        }

        this.objs.push(obj);
    },

    init(kind) {
        const ev = this.alloc();
        ev.kind = kind;
        return ev;
    }
};

const ParseNext = {
    VALUE:          0,
    KEY:            1,
    COMMA_OR_END:   2,
    COLON:          3,
};

function parseJSONInner() {
    return {
        finish_gen: null,
        next: ParseNext.VALUE,

        nest_stack: [],
        pos_stack: [],
        len: 0,

        pos: 0,
        erroed: false,
        done: false,

        transform(chunk, controller) {
            if (chunk.length === 0) return;

            const start = this.pos;
            if (this.finish_gen !== null) {
                this.finish_gen.next([chunk, controller]);
            }

            while (this.pos - start < chunk.length && !this.errored && !this.done) {
                const c = chunk[this.pos - start];
                switch (this.next) {
                    case ParseNext.VALUE: {
                        switch (c) {
                            case '{': {
                                this.push(NestKind.OBJECT);
                                this.next = ParseNext.KEY;
                                controller.enqueue(EVENT_POOL.START_OBJ);
                                this.pos++;
                                break;
                            }

                            case '[': {
                                this.push(NestKind.ARRAY);
                                this.next = ParseNext.VALUE,
                                controller.enqueue(EVENT_POOL.START_ARRAY);
                                this.pos++;
                                break;
                            }

                            case 't': {
                                this.parseVerbatim("true", EventKind.TRUE, chunk, controller);
                                break;
                            }

                            case 'f': {
                                this.parseVerbatim("false", EventKind.FALSE, chunk, controller);
                                break;
                            }

                            case 'n': {
                                this.parseVerbatim("null", EventKind.NULL, chunk, controller);
                                break;
                            }

                            case '"':
                                this.parseString(chunk);
                                break;

                            default:
                                this.error(controller);
                                break;
                        }
                        break;
                    } // ParseNext.VALUE

                    case ParseNext.KEY: {
                        if (c !== '"') {
                            this.error(controller);
                            continue;
                        }

                        this.parseString(chunk);
                    }

                    case ParseNext.COLON: {
                        if (c !== ':') {
                            this.error(controller);
                            continue;
                        }
                        this.pos++;
                    }

                    case ParseNext.COMMA_OR_END: {
                        switch (c) {
                            case '}': {
                                const top = this.top();
                                if (top === null) {
                                    this.error(controller);
                                    break;
                                }

                                if (this.nest_stack[top] !== NestKind.OBJECT) {
                                    this.error(controller);
                                    break;
                                }
                                this.pop();

                                controller.enqueue(EVENT_POOL.END_OBJ);
                                this.pos++;
                                this.finish_value();
                                break;
                            }

                            case ']': {
                                const top = this.top();
                                if (top === null) {
                                    this.error(controller);
                                    break;
                                }

                                if (this.nest_stack[top] !== NestKind.ARRAY) {
                                    this.error(controller);
                                    break;
                                }
                                this.pop();

                                controller.enqueue(EVENT_POOL.END_ARRAY);
                                this.pos++;
                                this.finish_value();
                                break;
                            }

                            case ',': {
                                const top = this.top();
                                if (top === null) {
                                    this.error(controller);
                                    continue;
                                }

                                switch (this.nest_stack[top]) {
                                    case NestKind.OBJECT: {
                                        this.next = ParseNext.KEY;
                                        break;
                                    }

                                    case NestKind.ARRAY: {
                                        this.next = ParseNext.VALUE;
                                        break;
                                    }

                                    default: throw "unreachable";
                                }
                                this.pos++;
                                break;
                            }

                            default: this.error(controller); continue;
                        }
                    } // ParseNext.COMMA_OR_END
                }
            }
        },

        push(kind) {
            this.nest_stack.push(kind);
            this.pos_stack.push(this.pos);
        },

        top() {
            if (this.nest_stack.length === 0) return null;
            return this.nest_stack.length-1;
        },

        stack_len() {
            return this.nest_stack.length;
        },

        pop() {
            this.nest_stack.pop();
            this.pos_stack.pop();
        },

        error(controller) {
            controller.enqueue(EVENT_POOL.ERROR);
            this.errored = true;
        },

        finish_value() {
            this.finish_gen = null;
            const top = this.top();
            if (top === null) {
                this.done = true;
                return;
            }
            this.next = ParseNext.COMMA_OR_END;
        },

        parseVerbatim(str, kind, chunk, controller) {
            switch (tryParseVerbatim(str, chunk)) {
                case ParseVerbatimResult.OK:
                    controller.enqueue(kind);
                    this.pos += str.length;
                    this.finish_value();
                    break;

                case ParseVerbatimResult.Err:
                    this.error(controller);
                    break;

                case ParseVerbatimResult.Partial:
                    // Slow path
                    this.finish_gen = parseVerbatimGen(str, kind, chunk, controller);
                    this.finish_gen.next();
                    break;
            }
        },

        *parseVerbatimGen(str, kind, chunk, controller) {
            while (true) {
                switch (tryParseVerbatim(str, chunk)) {
                    case ParseVerbatimResult.OK:
                        controller.enqueue(kind);
                        this.pos += str.length;
                        this.finish_value();
                        return;

                    case ParseVerbatimResult.Err:
                        this.error(controller);
                        return;

                    case ParseVerbatimResult.Partial:
                        this.pos += chunk.length;
                        str = str.slice(chunk.length);
                        [chunk, controller] = yield;
                        break;
                }
            }
        },

        // Assumes `chunk[0] == '"'`
        parseString(chunk, controller) {
            outer: for (let i = 1; i < chunk.length;) {
                if (chunk[i] === '\\') {
                    i++;
                    this.pos++;
                    if (i == chunk.length) break;
                    switch (chunk[i]) {
                        case '"':
                        case '\\':
                        case '/':
                        case 'b':
                        case 'f':
                        case 'n':
                        case 'r':
                        case 't':
                            i++;
                            this.pos++;
                            break;

                        case 'u':
                            // 4 hex digits
                            for (let j = i; j < i + 4; j++) {
                                if (j == chunk.length) break outer;
                                const codePoint = chunk.codePointAt(j);
                                if ( (codePoint >= 48 && codePoint <= 57)  /* 0-9 */
                                  || (codePoint >= 65 && codePoint <= 70)  /* A-F */
                                  || (codePoint >= 97 && codePoint <= 102) /* a-f */) {
                                    // Invalid escape sequence
                                    this.error(controller);
                                    return;
                                }
                            }
                            break;

                        default:
                            // Invalid escape sequence
                            this.error(controller);
                            return;
                    }
                } else if (chunk[i] == '"') {
                    i++;
                    this.pos++;
                    const s = JSON.parse(chunk.slice(0, i));
                    const ev = EVENT_POOL.alloc();
                    ev.kind = EventKind.STRING;
                    ev.content = s;
                    controller.enqueue(ev);
                    this.finish_value();
                    return;
                } else {
                    i++;
                    this.pos++;
                }
            }
            // The entire string is not contained in `chunk`.
            // Slow path, allocate the generator
            this.finish_gen = this.parseStringGen(chunk, controller);
            this.finish_gen.next();
        }, // parseString

        *parseStringGen(chunk, controller) {
            let acc = "";
            let i = 1;
            while (true) {
                if (i == chunk.length) {
                    acc += chunk;
                    [chunk, controller] = yield;
                    i = 0;
                }

                const c = chunk[i];
                if (c === '\\') {
                    i++;
                    if (i == chunk.length) {
                        acc += chunk;
                        [chunk, controller] = yield;
                        i = 0;
                    }
                    switch (chunk[i]) {
                        case '"':
                        case '\\':
                        case '/':
                        case 'b':
                        case 'f':
                        case 'n':
                        case 'r':
                        case 't':
                            i++;
                            break;

                        case 'u':
                            // 4 hex digits
                            for (let j = i; j < i + 4; j++) {
                                if (j == chunk.length) {
                                    acc += chunk;
                                    [chunk, controller] = yield;
                                    j -= i;
                                    i = 0;
                                }
                                const codePoint = chunk.codePointAt(j);
                                if ( (codePoint >= 48 && codePoint <= 57)  /* 0-9 */
                                  || (codePoint >= 65 && codePoint <= 70)  /* A-F */
                                  || (codePoint >= 97 && codePoint <= 102) /* a-f */) {
                                    // Invalid escape sequence
                                    this.error(controller);
                                    return;
                                }
                            }
                            break;

                        default:
                            // Invalid escape sequence
                            this.error(controller);
                            return;
                    }
                } else if (chunk[i] == '"') {
                    i++;
                    this.pos++;
                    acc += chunk.slice(0, i);
                    const s = JSON.parse(acc);
                    const ev = EVENT_POOL.alloc();
                    ev.kind = EventKind.STRING;
                    ev.content = s;
                    controller.enqueue(ev);
                    this.finish_value();
                    return;
                } else {
                    i++;
                    this.pos++;
                }
            }
        }
    };
}

function parseJSON() {
    return new TransformStream(parseJSONInner());
}

function tryParseVerbatim(match, chunk) {
    if (chunk.length >= match.length) {
        if (chunk.startsWith(match))
            return ParseVerbatimResult.OK;
        else
            return ParseVerbatimResult.Err;
    } else if (match.startsWith(chunk)) {
        return ParseVerbatimResult.Partial;
    } else {
        return ParseVerbatimResult.Err;
    }
}
