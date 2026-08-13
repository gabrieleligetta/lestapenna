describe('PROCESS_ROLE', () => {
    const original = process.env.PROCESS_ROLE;

    afterEach(() => {
        process.env.PROCESS_ROLE = original;
        jest.resetModules();
    });

    it('defaults to backwards-compatible all-in-one mode', () => {
        delete process.env.PROCESS_ROLE;
        const role = require('../../../src/services/processRole');
        expect(role.getProcessRole()).toBe('all');
        expect(role.processRunsGateway()).toBe(true);
        expect(role.processRunsWorkers()).toBe(true);
    });

    it('separates gateway and worker responsibilities', () => {
        process.env.PROCESS_ROLE = 'gateway';
        let role = require('../../../src/services/processRole');
        expect(role.processRunsGateway()).toBe(true);
        expect(role.processRunsWorkers()).toBe(false);

        jest.resetModules();
        process.env.PROCESS_ROLE = 'worker';
        role = require('../../../src/services/processRole');
        expect(role.processRunsGateway()).toBe(false);
        expect(role.processRunsWorkers()).toBe(true);
    });
});
