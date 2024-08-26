/**
 * IndexedDB wrapper for defining typed stores and working with them.
 */
type LocalDBCallback<RecordT extends Object> = {
  event: "select" | "selectMany" | "insert" | "update" | "delete";
  data: RecordT | RecordT[];
};
type StoreDefinition<RecordT extends Object> = {
  storeName: string;
  /**Define all top level fields in each record and apply options. Set null
   * if field doesn't need any special settings.
   */
  fields: Record<
    keyof RecordT,
    {
      primaryKey?: boolean;
      preventIndex?: boolean;
      isDateString?: boolean;
    } | null
  >;
  version?: number;
  onCallback?: (event: LocalDBCallback<RecordT>) => any;
  /**Functions that modify records coming in and out of indexedDB.
   * Most used to convert dates represented as strings or Date ojects to numbers
   * for use in index searches.
   */
  transform?: {
    in: (record: RecordT) => Record<keyof RecordT, any>;
    out: (record: Record<keyof RecordT, any>) => RecordT;
  };
};

export let dbConfig = {
  name: "defaultDB",
  /**Recreate database on every init */
  debug: false,
  /**Validate store only. No data will be seeded. Used for testing */
  validateOnly: false,
};
export let allStores: StoreDefinition<any>[] = [];
let versionNbr = 0;
let initialized = false; // True once stores are all initialized and worker should be registered

function getKeyFields<RecordT extends Object>(store: StoreDefinition<RecordT>) {
  let dateFieldKeys: (keyof RecordT)[] = [];
  let primaryKey: keyof RecordT | (keyof RecordT)[] | undefined = undefined;
  let indexes: (keyof RecordT)[] = [];
  const fields = Object.entries(store.fields);
  fields.forEach((field) => {
    const name = field[0] as keyof RecordT;
    const fieldConfig = field[1];
    // Validate field names can be indexed
    const invalidChars = field[0].match("[^a-zA-Z0-9_]+$");
    if (invalidChars && !fieldConfig?.preventIndex) {
      throw new Error(
        `Invalid field name: ${field[0]}. Names being indexed may only include alphanumeric characters (A-Z, a-z, 0-9) and underscores (_)`
      );
    }
    if (fieldConfig?.primaryKey) {
      // This field is marked as a primary key
      // If primary key already exists, make composite primary key
      const pkType = typeof primaryKey;
      switch (pkType) {
        case "string":
          const pk = primaryKey;
          primaryKey = [pk as keyof RecordT, name];
          break;
        case "undefined":
          primaryKey = name;
          break;
        default:
          if (primaryKey!.constructor === Array) {
            primaryKey.push(name);
          }
      }
    }
    fieldConfig?.isDateString ? dateFieldKeys.push(name) : undefined;
    if (!(fieldConfig?.preventIndex || fieldConfig?.primaryKey)) {
      indexes.push(name);
    }
  });
  if (!primaryKey) {
    throw new Error(`No primary key defined on store ${store.storeName}"`);
  }
  const primary: keyof RecordT | (keyof RecordT)[] = primaryKey;
  if (Array.isArray(primary)) {
    // Index primary key fields if composite primary keys
    // @ts-ignore
    primary.forEach((k) => indexes.push(k));
    indexes.push();
  }
  return { primary, indexes, dateFieldKeys };
}

async function deleteDB() {
  return new Promise((resolve, reject) => {
    console.debug("deleting existing defaultDB");
    const deleteDB = indexedDB.deleteDatabase(dbConfig.name);
    deleteDB.onsuccess = () => {
      console.debug("deleted db");
      resolve(deleteDB.result);
    };
    deleteDB.onerror = () => reject("Unable to delete existing db");
  });
}

export class StoreModel<RecordT extends Object> {
  // All  return promises if they’re async
  private store: StoreDefinition<RecordT>;
  private dateFieldKeys: (keyof RecordT)[] = [];
  private primaryKey: keyof RecordT | (keyof RecordT)[] | undefined = undefined;
  private indexes: (keyof RecordT)[] = [];

  constructor(store: StoreDefinition<RecordT>) {
    allStores.push(store);
    versionNbr += (store.version ?? 0) + 1;
    this.store = store;
    const keyFields = getKeyFields(store);
    this.dateFieldKeys = keyFields.dateFieldKeys;
    this.primaryKey = keyFields.primary;
    this.indexes = keyFields.indexes;
    console.debug(
      `${store.storeName} init complete. primaryKey: `,
      this.primaryKey,
      ", indexes: ",
      this.indexes,
      ", dateFields: ",
      this.dateFieldKeys
    );
  }

  private valueToStorage(value: RecordT) {
    let returnValue: Record<keyof RecordT, any> = value;
    if (this.store.transform) {
      returnValue = this.store.transform.in(value);
    }
    this.dateFieldKeys.forEach((k) => {
      returnValue[k] = new Date(returnValue[k] as string);
    });
    return returnValue;
  }
  private valueFromStorage(value: Record<keyof RecordT, any>) {
    let returnValue: RecordT = value;
    this.dateFieldKeys.forEach((k) => {
      const dateField: Date = value[k];
      returnValue[k] = dateField.toJSON() as RecordT[keyof RecordT];
    });
    if (this.store.transform) {
      returnValue = this.store.transform.out(returnValue);
    }
    return returnValue;
  }

  private async openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const dbReq = indexedDB.open(dbConfig.name, versionNbr);
      dbReq.onerror = (e) => reject(`IndexedDB error event: ${e.target}`);
      dbReq.onupgradeneeded = () => {
        const db = dbReq.result;
        // storesNeedingSeedData = [];
        allStores.forEach(async (store) => {
          if (db.objectStoreNames.contains(store.storeName)) {
            // Delete store if it exists to recreate it with latest schema on upgrade
            db.deleteObjectStore(store.storeName);
          }
          const keys = getKeyFields(store);
          const newStore = db.createObjectStore(store.storeName, {
            keyPath: keys.primary as string | string[],
          });
          keys.indexes.forEach((idx) => {
            newStore.createIndex(idx as string, idx as string);
          });
        });
      };
      dbReq.onsuccess = () => {
        if (!initialized) {
          initialized = true;
        } else {
          initialized = true;
        }
        resolve(dbReq.result);
      };
    });
  }

  private async getDB() {
    if (dbConfig.debug) {
      // Delete and recreate database on startup if in debug mode
      await deleteDB();
    }
    let db = await this.openDB(); // First call to openDB will mark stores that need seed data
    return db;
  }

  async select(
    query: IDBValidKey | IDBKeyRange,
    indexName?: keyof RecordT
  ): Promise<RecordT | undefined> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store.storeName, "readonly");
      const os = tx.objectStore(this.store.storeName);
      let index: IDBObjectStore | IDBIndex = os;
      if (indexName) {
        index = os.index(indexName as string);
      }
      const request = index.get(query);
      request.onsuccess = () => {
        const result = this.valueFromStorage(request.result);
        tx.commit();
        if (this.store.onCallback) {
          this.store.onCallback({ event: "select", data: result });
        }
        resolve(result);
      };
      request.onerror = (e) => {
        reject(`Rejected with error: ${e.target}`);
      };
    });
  }

  async selectMany(options?: {
    query?: IDBValidKey | IDBKeyRange;
    limit?: number;
    index?: keyof RecordT;
  }): Promise<RecordT[]> {
    console.time("selectManyTimer");
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store.storeName, "readonly");
      const os = tx.objectStore(this.store.storeName);
      let index: IDBObjectStore | IDBIndex = os;
      if (options?.index) {
        index = os.index(options.index as string);
      }
      const request = index.getAll(options?.query, options?.limit);
      let idbRecords: Record<keyof RecordT, any>[];
      let result: RecordT[] = [];
      request.onsuccess = () => {
        idbRecords = request.result;
        if (this.store.transform) {
          idbRecords.forEach((r) => {
            result.push(this.valueFromStorage(r));
          });
        } else {
          result = idbRecords;
        }
        tx.commit();
        if (this.store.onCallback) {
          this.store.onCallback({ event: "selectMany", data: result });
        }
        console.timeEnd("selectManyTimer");
        resolve(result);
      };
      request.onerror = (e) => {
        reject(`Rejected with error: ${e.target}`);
      };
    });
  }

  async insert(value: RecordT) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store.storeName, "readwrite");
      const os = tx.objectStore(this.store.storeName);
      const valueIn = this.valueToStorage(value);
      const request = os.add(valueIn);
      request.onsuccess = () => {
        if (this.store.onCallback) {
          this.store.onCallback({ event: "insert", data: valueIn });
        }
        tx.commit();
        resolve(undefined);
      };
      request.onerror = (e) => {
        reject(`Rejected with error: ${e.target}`);
      };
    });
  }

  async update(value: RecordT) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store.storeName, "readwrite");
      const os = tx.objectStore(this.store.storeName);
      const valueIn = this.valueToStorage(value);
      const request = os.put(valueIn);
      request.onsuccess = () => {
        if (this.store.onCallback) {
          this.store.onCallback({ event: "update", data: valueIn });
        }
        tx.commit();
        resolve(undefined);
      };
      request.onerror = (e) => {
        reject(`Rejected with error: ${e.target}`);
      };
    });
  }

  async delete(key: IDBValidKey | IDBKeyRange) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store.storeName, "readwrite");
      const os = tx.objectStore(this.store.storeName);
      const request = os.delete(key);
      request.onsuccess = () => {
        if (this.store.onCallback) {
          this.store.onCallback({ event: "delete", data: [] });
        }
        tx.commit();
        resolve(undefined);
      };
      request.onerror = (e) => {
        reject(`Rejected with error: ${e.target}`);
      };
    });
  }
}

module.exports = { dbConfig, allStores, StoreModel };
