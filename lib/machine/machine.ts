/*
 * Copyright © 2018 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    allSatisfied,
    goal,
    goals,
    hasFile,
    not, ProductionEnvironment,
    SoftwareDeliveryMachine,
    SoftwareDeliveryMachineConfiguration,
    spawnLog, StagingEnvironment,
    whenPushSatisfies,
} from "@atomist/sdm";
import {
    createSoftwareDeliveryMachine, goalScheduling,
    Version,
} from "@atomist/sdm-core";
import { Build } from "@atomist/sdm-pack-build";
import {
    DockerBuild,
    HasDockerfile,
} from "@atomist/sdm-pack-docker";
import {
    IsMaven,
    mavenBuilder,
    MavenProjectVersioner, MvnPackage, MvnVersion,
} from "@atomist/sdm-pack-spring";
import {KubernetesDeploy} from "@atomist/sdm-pack-k8s";

/**
 * Initialize an sdm definition, and add functionality to it.
 *
 * @param configuration All the configuration for this service
 */
export function machine(
    configuration: SoftwareDeliveryMachineConfiguration,
): SoftwareDeliveryMachine {

    const sdm = createSoftwareDeliveryMachine({
        name: "ABSA SDM",
        configuration,
    });

    const versionGoal = new Version().withVersioner(MavenProjectVersioner);

    const buildGoal = new Build({ isolate: true }).with({
        builder: mavenBuilder(),
        pushTest: allSatisfied(IsMaven, not(hasFile(".atomist/build.sh"))),
    }).with({
        pushTest: hasFile(".atomist/build.sh"),
        builder: async goalInvocation => {
            const { context, credentials, id } = goalInvocation;
            return goalInvocation.configuration.sdm.projectLoader.doWithProject({ context, credentials, id, readOnly: false  }, async p => {
                const result = await spawnLog(".atomist/build.sh", [], { cwd: p.baseDir, log: goalInvocation.progressLog });
                return {
                    code: result.code,
                } as any;
            });
        },
    });

    const dockerBuildGoal = new DockerBuild({ retry: true, isolate: true }).with({
        options: {
            push: false,
            /*dockerfileFinder: async p => {
                if (await p.hasFile("Dockerfile")) {
                    return "Dockerfile";
                } else if (await p.hasFile("src/main/docker/Dockerfile")) {
                    return "src/main/docker/Dockerfile";
                } else {
                    throw new Error("Don't know where to find Dockerfile");
                }
            },*/
        },
        pushTest: HasDockerfile,
    })
        .withProjectListener(MvnVersion)
        .withProjectListener(MvnPackage);

    const testingDeployGoal = new KubernetesDeploy({ environment: StagingEnvironment})
        .with({
            name: "@atomist/k8s-sdm_minikube",
            applicationData: async app => {
                app.ns = "testing";
                app.path = "/";
                app.host = `${app.name}.${app.ns}.192.168.99.100.nip.io`;
                return app;
            },
        });

    const prodDeployGoal = new KubernetesDeploy({ environment: ProductionEnvironment, preApproval: true})
        .with({
            name: "@atomist/k8s-sdm_minikube",
            applicationData: async app => {
                app.ns = "prod";
                app.path = "/";
                app.host = `${app.name}.${app.ns}.192.168.99.100.nip.io`;
                return app;
            },
        });

    const buildGoals = goals("build")
        .plan(versionGoal)
        .plan(buildGoal).after(versionGoal);

    const dockerBuildGoals = goals("docker build")
        .plan(dockerBuildGoal).after(buildGoal);

    const deployGoals = goals("Deploy goals")
        .plan(testingDeployGoal).after(dockerBuildGoals)
        .plan(prodDeployGoal).after(testingDeployGoal);

    sdm.withPushRules(
        whenPushSatisfies(IsMaven).setGoals(buildGoals),
        whenPushSatisfies(IsMaven, HasDockerfile).setGoals(dockerBuildGoals),
        whenPushSatisfies(IsMaven, HasDockerfile).setGoals(deployGoals),
    );

    sdm.addExtensionPacks(goalScheduling())

    return sdm;
}