/**
 * IndexedDB wrapper for defining typed stores and working with them.
 */

/**Interface that a FieldTransformer object should implement to properly convert data types
 * to and from indexedDB storage.
 *
 * Ex: converting a date to a string for storage and back to a Date for use in js
 */
export interface FieldTransformer<T> {
  toJSON(field: T): any;
  fromJSON(field: any): T;
}

export const DateTransformer: FieldTransformer<Date> = {
  toJSON(field: Date) {
    return field.toJSON();
  },

  fromJSON(field: string): Date {
    return new Date(field);
  },
};

export let dbConfig = {
  name: "defaultDB",
  /**Recreate database on every init */
  debug: false,
  /**Validate store only. No data will be seeded. Used for testing */
  validateOnly: false,
};
let versionNbr = 0;
let initialized = false; // True once stores are all initialized and worker should be registered

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

let allStores: {
  storeName: string;
  indexes: string[];
  primaryKey: string | string[];
}[] = [];

export class StoreModel<RecordT extends Object> {
  // All  return promises if they’re async
  private storeConfig: {
    storeName: string;
    fields: Record<
      keyof RecordT,
      {
        primaryKey?: boolean;
        preventIndex?: boolean;
        typeTransformer?: FieldTransformer<any>;
      } | null
    >;
    version?: number;
  };
  private primaryKey: keyof RecordT | (keyof RecordT)[] | undefined = undefined;
  private indexes: (keyof RecordT)[] = [];
  private transformFields: (keyof RecordT)[] = []; // Fields with defined transformer class

  constructor(storeConfig: typeof this.storeConfig) {
    this.storeConfig = storeConfig;
    this.getKeyFields();
    allStores.push({
      storeName: this.storeConfig.storeName,
      indexes: this.indexes as string[],
      primaryKey: this.primaryKey as string | string[],
    });
    versionNbr += (this.storeConfig.version ?? 0) + 1;
    console.debug(
      `${this.storeConfig.storeName} init complete. primaryKey: `,
      this.primaryKey,
      ", indexes: ",
      this.indexes
    );
  }

  /**Parse the key fields and set store settings for them */
  private getKeyFields() {
    const fields = Object.entries(this.storeConfig.fields);
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
        const pkType = typeof this.primaryKey;
        switch (pkType) {
          case "string":
            const pk = this.primaryKey;
            this.primaryKey = [pk as keyof RecordT, name];
            break;
          case "undefined":
            this.primaryKey = name;
            break;
          default:
            if (this.primaryKey!.constructor === Array) {
              this.primaryKey.push(name);
            }
        }
      }
      fieldConfig?.typeTransformer
        ? this.transformFields.push(name)
        : undefined;
      if (!(fieldConfig?.preventIndex || fieldConfig?.primaryKey)) {
        this.indexes.push(name);
      }
    });
    if (!this.primaryKey) {
      throw new Error(
        `No primary key defined on store ${this.storeConfig.storeName}"`
      );
    }
    if (Array.isArray(this.primaryKey)) {
      // Index primary key fields if composite primary keys
      this.primaryKey.forEach((k) => this.indexes.push(k));
    }
  }

  private valueToStorage(value: RecordT) {
    let returnValue: Record<keyof RecordT, any> = value;
    if (!this.transformFields) {
      return value;
    }
    this.transformFields.forEach((k) => {
      const transformer = this.storeConfig.fields[k]!.typeTransformer!;
      returnValue[k] = transformer.toJSON(returnValue[k]);
    });
    return returnValue;
  }
  private valueFromStorage(value: Record<keyof RecordT, any>) {
    let returnValue = value;
    if (!this.transformFields) {
      return returnValue;
    }
    this.transformFields.forEach((k) => {
      const transformer = this.storeConfig.fields[k]!.typeTransformer!;
      returnValue[k] = transformer.fromJSON(returnValue[k]);
    });
    return returnValue;
  }

  private async openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const dbReq = indexedDB.open(dbConfig.name, versionNbr);
      dbReq.onerror = (e) => reject(`IndexedDB error event: ${e.target}`);
      dbReq.onupgradeneeded = () => {
        const db = dbReq.result;
        allStores.forEach(async (store) => {
          if (db.objectStoreNames.contains(store.storeName)) {
            // Delete store if it exists to recreate it with latest schema on upgrade
            db.deleteObjectStore(store.storeName);
          }
          const newStore = db.createObjectStore(store.storeName, {
            keyPath: store.primaryKey as string | string[],
          });
          store.indexes.forEach((idx) => {
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
      const tx = db.transaction(this.storeConfig.storeName, "readonly");
      const os = tx.objectStore(this.storeConfig.storeName);
      let index: IDBObjectStore | IDBIndex = os;
      if (indexName) {
        index = os.index(indexName as string);
      }
      const request = index.get(query);
      request.onsuccess = () => {
        const result = this.valueFromStorage(request.result);
        tx.commit();
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
      const tx = db.transaction(this.storeConfig.storeName, "readonly");
      const os = tx.objectStore(this.storeConfig.storeName);
      let index: IDBObjectStore | IDBIndex = os;
      if (options?.index) {
        index = os.index(options.index as string);
      }
      const request = index.getAll(options?.query, options?.limit);
      let idbRecords: Record<keyof RecordT, any>[];
      let result: RecordT[] = [];
      request.onsuccess = () => {
        idbRecords = request.result;
        if (this.transformFields) {
          idbRecords.forEach((r) => {
            result.push(this.valueFromStorage(r));
          });
        } else {
          result = idbRecords;
        }
        tx.commit();
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
      const tx = db.transaction(this.storeConfig.storeName, "readwrite");
      const os = tx.objectStore(this.storeConfig.storeName);
      const valueIn = this.valueToStorage(value);
      const request = os.add(valueIn);
      request.onsuccess = () => {
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
      const tx = db.transaction(this.storeConfig.storeName, "readwrite");
      const os = tx.objectStore(this.storeConfig.storeName);
      const valueIn = this.valueToStorage(value);
      const request = os.put(valueIn);
      request.onsuccess = () => {
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
      const tx = db.transaction(this.storeConfig.storeName, "readwrite");
      const os = tx.objectStore(this.storeConfig.storeName);
      const request = os.delete(key);
      request.onsuccess = () => {
        tx.commit();
        resolve(undefined);
      };
      request.onerror = (e) => {
        reject(`Rejected with error: ${e.target}`);
      };
    });
  }
}

/**@ts-ignore */
module.exports = { dbConfig, allStores, StoreModel };
