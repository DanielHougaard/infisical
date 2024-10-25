/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import handlebars from "handlebars";
import hdb from "hdb";
import { customAlphabet } from "nanoid";
import { z } from "zod";

import { getConfig } from "@app/lib/config/env";
import { BadRequestError } from "@app/lib/errors";
import { alphaNumericNanoId } from "@app/lib/nanoid";

import { DynamicSecretSapHanaSchema, TDynamicProviderFns } from "./models";

const generatePassword = (size = 48) => {
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return customAlphabet(charset, 48)(size);
};

const generateUsername = () => {
  return alphaNumericNanoId(32);
};

export const SapHanaProvider = (): TDynamicProviderFns => {
  const validateProviderInputs = async (inputs: unknown) => {
    const appCfg = getConfig();
    const providerInputs = await DynamicSecretSapHanaSchema.parseAsync(inputs);

    if (
      appCfg.isCloud &&
      // localhost
      // internal ips
      (providerInputs.host === "host.docker.internal" ||
        providerInputs.host.match(/^10\.\d+\.\d+\.\d+/) ||
        providerInputs.host.match(/^192\.168\.\d+\.\d+/))
    )
      throw new BadRequestError({ message: "Invalid db host" });

    if (providerInputs.host === "localhost" || providerInputs.host === "127.0.0.1") {
      throw new BadRequestError({ message: "Invalid db host" });
    }

    return providerInputs;
  };

  const getClient = async (providerInputs: z.infer<typeof DynamicSecretSapHanaSchema>) => {
    const client = hdb.createClient({
      host: providerInputs.host,
      port: providerInputs.port,
      user: providerInputs.username,
      password: providerInputs.password,
      ...(providerInputs.ca
        ? {
            ca: providerInputs.ca
          }
        : {})
    });

    await new Promise((resolve, reject) => {
      client.connect((err: any) => {
        if (err) {
          return reject(err);
        }

        if (client.readyState) {
          return resolve(true);
        }

        reject(new Error("SAP HANA client not ready"));
      });
    });

    return client;
  };

  const validateConnection = async (inputs: unknown) => {
    const providerInputs = await validateProviderInputs(inputs);
    const client = await getClient(providerInputs);

    const testResult: boolean = await new Promise((resolve, reject) => {
      client.exec("SELECT 1 FROM DUMMY;", (err: any) => {
        if (err) {
          reject();
        }

        resolve(true);
      });
    });

    return testResult;
  };

  const create = async (inputs: unknown, expireAt: number) => {
    const providerInputs = await validateProviderInputs(inputs);

    const username = generateUsername();
    const password = generatePassword();
    const expiration = new Date(expireAt).toISOString();

    const client = await getClient(providerInputs);
    const creationStatement = handlebars.compile(providerInputs.creationStatement, { noEscape: true })({
      username,
      password,
      expiration
    });

    const queries = creationStatement.toString().split(";").filter(Boolean);
    for await (const query of queries) {
      await new Promise((resolve, reject) => {
        client.exec(query, (err: any) => {
          if (err) {
            reject(
              new BadRequestError({
                message: err.message
              })
            );
          }
          resolve(true);
        });
      });
    }

    return { entityId: username, data: { DB_USERNAME: username, DB_PASSWORD: password } };
  };

  const revoke = async (inputs: unknown, username: string) => {
    const providerInputs = await validateProviderInputs(inputs);
    const client = await getClient(providerInputs);
    const revokeStatement = handlebars.compile(providerInputs.revocationStatement)({ username });
    const queries = revokeStatement.toString().split(";").filter(Boolean);
    for await (const query of queries) {
      await new Promise((resolve, reject) => {
        client.exec(query, (err: any) => {
          if (err) {
            reject(
              new BadRequestError({
                message: err.message
              })
            );
          }
          resolve(true);
        });
      });
    }

    return { entityId: username };
  };

  const renew = async (inputs: unknown, username: string, expireAt: number) => {
    const providerInputs = await validateProviderInputs(inputs);
    const client = await getClient(providerInputs);
    try {
      const expiration = new Date(expireAt).toISOString();

      const renewStatement = handlebars.compile(providerInputs.renewStatement)({ username, expiration });
      const queries = renewStatement.toString().split(";").filter(Boolean);
      for await (const query of queries) {
        await new Promise((resolve, reject) => {
          client.exec(query, (err: any) => {
            if (err) {
              reject(
                new BadRequestError({
                  message: err.message
                })
              );
            }
            resolve(true);
          });
        });
      }
    } finally {
      client.disconnect();
    }

    return { entityId: username };
  };

  return {
    validateProviderInputs,
    validateConnection,
    create,
    revoke,
    renew
  };
};
