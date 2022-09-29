import "./type-extensions";
import * as fs from "fs";
import { createHash } from "crypto";
import {
  TASK_COMPILE_GET_COMPILATION_TASKS,
  TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS,
  TASK_COMPILE_SOLIDITY_RUN_SOLC,
} from "hardhat/builtin-tasks/task-names";
import { extendConfig, subtask, types } from "hardhat/config";
import { glob } from "hardhat/internal/util/glob";
import { CompilerInput, HardhatConfig, HardhatUserConfig } from "hardhat/types";
import path from "path";
import { ContractInfo } from "./ethers/Contract";
import { HashInfo } from "./Hash";
import {
  TASK_COMPILE_WARP_GET_HASH,
  TASK_COMPILE_WARP_GET_SOURCE_PATHS,
  TASK_COMPILE_WARP_GET_WARP_PATH,
  TASK_COMPILE_WARP_RUN_BINARY,
  TASK_DEPLOY_WARP_GET_CAIRO_PATH,
  TASK_WRITE_CONTRACT_INFO,
} from "./task-names";
import { Transpiler } from "./transpiler";
import {
  checkHash,
  compile,
  getContract,
  saveContract,
  WarpPluginError,
} from "./utils";
import { getTestAccounts, getTestProvider } from './fixtures';

import { extendEnvironment } from "hardhat/config";
import {WarpSigner} from "./ethers/Signer";
import {ContractFactory, getStarknetContractFactory} from "./ethers/ContractFactory";

// Hack to wreck safety

extendEnvironment((hre) => {
  // @ts-ignore hre doesn't contain the ethers type information which is set by hardhat
  const getContractFactory = hre.ethers.getContractFactory;

  // @ts-ignore hre doesn't contain the ethers type information which is set by hardhat
  const getSignersEthers = hre.ethers.getSigners;

  // @ts-ignore hre doesn't contain the ethers type information which is set by hardhat
  hre.ethers.getContractFactory = async (name) => {
    // @ts-ignore hre doesn't contain the ethers type information which is set by hardhat
    const ethersSigners = await getSignersEthers();
    const ethersContractFactory = await getContractFactory(
      name,
      ethersSigners[0]
    );
    const starknetContractFactory = getStarknetContractFactory(name);
    const contract = getContract(name);
    const cairoFile = contract.getCairoFile().slice(0, -6).concat(".cairo");
    return Promise.resolve(
      new ContractFactory(
        starknetContractFactory,
        ethersContractFactory,
        cairoFile
      )
    );
  };


  // @ts-ignore hre doesn't contain the ethers type information which is set by hardhat
  hre.ethers.getSigners = async () => {
    const testProvider = getTestProvider();
    const starknetSigners = await getTestAccounts(testProvider);

    const warpSigners = starknetSigners.map((starknetSigner) =>
      new WarpSigner(starknetSigner));

    return Promise.resolve(warpSigners);
  };

  // @ts-ignore hre doesn't contain the ethers type information which is set by hardhat
  hre.ethers.getSigner = async (address: string) => {
    if (address) throw new Error("Signers at exact address not supported yet")
    const testProvider = getTestProvider();
    const [starknetSigner] = await getTestAccounts(testProvider);

    const warpSigner = new WarpSigner(starknetSigner);

    return Promise.resolve(warpSigner);
  };

  // @ts-ignore hre doesn't contain the ethers type information which is set by hardhat
  hre.ethers.provider.formatter.address = (address: string): string => {
    try {
      const addressVal = BigInt(address);
      if (addressVal >= 2 ** 251) {
        throw new Error(`Address is not a valid starknet address ${address}`);
      }
      return address;
    } catch {
      throw new Error(`Address is not a valid starknet address ${address}`);
    }
  };

  // @ts-ignore hre doesn't contain the ethers type information which is set by hardhat
  hre.ethers.provider.formatter.hash = (address: string): string => {
    try {
      const addressVal = BigInt(address);
      if (addressVal >= 2 ** 251) {
        throw new Error(`Address is not a valid starknet address ${address}`);
      }
      return address;
    } catch {
      throw new Error(`Address is not a valid starknet address ${address}`);
    }
  };
});

extendConfig(
  (config: HardhatConfig, userConfig: Readonly<HardhatUserConfig>) => {
    const userWarpPath = userConfig.paths?.warp;

    let newPath: string;
    if (userWarpPath === undefined) {
      newPath = "UNDEFINED";
    } else {
      if (path.isAbsolute(userWarpPath)) {
        newPath = userWarpPath;
      } else {
        newPath = path.normalize(path.join(config.paths.root, userWarpPath));
      }
    }

    config.paths.warp = newPath;
  }
);

subtask(TASK_COMPILE_SOLIDITY_RUN_SOLC)
  .setAction(
    async ({ input }: { input: CompilerInput; solcPath: string }) => {

      const output = await compile(input);

    return output;
  }
);

subtask(
    TASK_COMPILE_GET_COMPILATION_TASKS,
    async (_, __, runSuper): Promise<string[]> => {
      return [
        ...await runSuper(),
        TASK_WRITE_CONTRACT_INFO,
      ];
    },
);

subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS,
    (_, {config}): Promise<string[]> => {
      return glob(path.join(config.paths.root, 'contracts/**/*.sol'));
    },
);

subtask(
  TASK_COMPILE_WARP_GET_SOURCE_PATHS,
  async (_, { config }): Promise<string[]> => {
    const starknetContracts = await glob(
      path.join(config.paths.root, "contracts/**/*.sol")
    );

    return starknetContracts.map((contract) =>
      path.relative(config.paths.root, contract)
    );
  }
);

subtask(TASK_COMPILE_WARP_GET_HASH)
  .addParam(
    "contract",
    "Path to Solidity contract",
    undefined,
    types.string,
    false
  )
  .setAction(
    async ({ contract }: { contract: string }): Promise<boolean> => {
      const readContract = fs.readFileSync(contract, "utf-8");
      const hash = createHash("sha256").update(readContract).digest("hex");
      const hashObj = new HashInfo(contract, hash);
      const needToCompile = checkHash(hashObj);
      return needToCompile;
    }
  );

subtask(TASK_WRITE_CONTRACT_INFO).setAction(
  async (_, { run }): Promise<void> => {
    const warpPath: string = await run(TASK_COMPILE_WARP_GET_WARP_PATH);

    const sourcePathsWarp: string[] = await run(
      TASK_COMPILE_WARP_GET_SOURCE_PATHS
    );

    const transpiler = new Transpiler(warpPath);
    for (const sourcepath of sourcePathsWarp) {
      const contractNames = await transpiler.getContractNames(sourcepath);
      contractNames.map((contractName) => {
        const contractObj = new ContractInfo(contractName, sourcepath);
        saveContract(contractObj);
      });
    }
  }
);

subtask(TASK_COMPILE_WARP_RUN_BINARY)
  .addParam(
    "contract",
    "Path to Solidity contract",
    undefined,
    types.string,
    false
  )
  .addParam("warpPath", "Path to warp binary", undefined, types.string, false)
  .setAction(
    async ({
      contract,
      warpPath,
    }: {
      contract: string;
      warpPath: string;
    }): Promise<void> => {
      const transpiler = new Transpiler(warpPath);
      transpiler.transpile(contract);
      const contractNames = await transpiler.getContractNames(contract);
      contractNames.map((contractName) => {
        const contractObj = new ContractInfo(contractName, contract);
        saveContract(contractObj);
      });
    }
  );

subtask(
  TASK_COMPILE_WARP_GET_WARP_PATH,
  async (_, { config }): Promise<string> => {
    if (config.paths.warp === "UNDEFINED") {
      throw new WarpPluginError(
        "Unable to find warp binary. Please set warp binary path in hardhat config"
      );
    }

    return config.paths.warp;
  }
);

// subtask(TASK_COMPILE_WARP)
//     .setAction(
//         async (_, {run}) => {
//           await run(TASK_COMPILE_WARP_PRINT_STARKNET_PROMPT);

//           const warpPath: string = await run(
//               TASK_COMPILE_WARP_GET_WARP_PATH,
//           );

//           const sourcePathsWarp: string[] = await run(
//               TASK_COMPILE_WARP_GET_SOURCE_PATHS,
//           );

//           const results = await Promise.all(sourcePathsWarp.map(async (source) => {
//             return await run(
//                 TASK_COMPILE_WARP_GET_HASH,
//                 {
//                   contract: source,
//                 },
//             );
//           }));

//           sourcePathsWarp.forEach(async (source, i) => {
//             if (results[i]) {
//               await run(
//                   TASK_COMPILE_WARP_RUN_BINARY,
//                   {
//                     contract: source,
//                     warpPath: warpPath,
//                   },
//               );
//             }
//           });
//         },
//     );

subtask(TASK_DEPLOY_WARP_GET_CAIRO_PATH)
  .addParam(
    "contractName",
    "Name of the contract to deploy",
    undefined,
    types.string,
    false
  )
  .setAction(async ({ contractName }: { contractName: string }) => {
    const contract = getContract(contractName);
    // TODO: catch exception
    return contract.getCairoFile();
  });
