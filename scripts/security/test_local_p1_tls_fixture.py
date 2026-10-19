"""Pure archive/identity/overlay tests. No Docker, SSH, database or provider calls."""
import importlib.util
import io
import json
import hashlib
from pathlib import Path
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location('local_p1_fixture', Path(__file__).with_name('local-p1-tls-fixture.py'))
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)


def required_files():
    files = {name: b'fixture' for name in fixture.REQUIRED}
    files['package.json'] = b'{"name":"fixture","private":true}'
    files['package-lock.json'] = b'{"lockfileVersion":3,"packages":{"node_modules/example":{"version":"1.0.0"}}}'
    files['packages/security-orchestration/package.json'] = b'{"name":"@zerochack/security-orchestration"}'
    files['packages/database/prisma/schema.prisma'] = b'model SecurityRepairRun {\n}\nmodel SecurityRepairAttempt {\n}\n'
    for index in range(30):
        files[f'packages/database/prisma/migrations/20000000000000_fixture_{index:02}/migration.sql'] = b'SELECT 1;'
    return files


def archive(files=None, extra=()):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w:gz', format=tarfile.USTAR_FORMAT) as output:
        for name, body in (required_files() if files is None else files).items():
            item = tarfile.TarInfo(name)
            item.size = len(body)
            output.addfile(item, io.BytesIO(body))
        for name, kind, body in extra:
            item = tarfile.TarInfo(name)
            item.type = kind
            if kind == tarfile.REGTYPE:
                item.size = len(body)
                output.addfile(item, io.BytesIO(body))
            else:
                item.linkname = '/etc/passwd'
                output.addfile(item)
    return data.getvalue()


class IdentityTests(unittest.TestCase):
    def test_exact_shared_binding_uses_archive_sha256_not_commit(self):
        source = 'a' * 64
        binding = fixture.fixture_identity(source, '0123abcd')
        self.assertEqual(binding, {
            'SECURITY_WORKPLACE_TEST_SOURCE_SHA': source,
            'SECURITY_WORKPLACE_TEST_ATTEMPT': '0123abcd',
            'SECURITY_WORKPLACE_TEST_DATABASE': 'codebandage_security_workplace_test_aaaaaaaaaaaa_0123abcd',
            'SECURITY_WORKPLACE_TEST_MARKER': 'codebandage-security-workplace-test-v1:' + source + ':0123abcd'
        })
        for source, attempt in (('a' * 40, '0123abcd'), ('A' * 64, '0123abcd'), ('a' * 64, 'bad'), ('a' * 64, 'abcd123;')):
            with self.subTest(source=source, attempt=attempt), self.assertRaises(RuntimeError):
                fixture.fixture_identity(source, attempt)

    def test_legacy_mode_is_explicit_separately_marked_and_postgres_name_bounded(self):
        source, attempt = 'a' * 64, '0123abcd'
        standard = fixture.fixture_identity(source, attempt)
        legacy = fixture.fixture_identity(source, attempt, True)
        self.assertNotIn('SECURITY_WORKPLACE_TEST_MODE', standard)
        self.assertEqual(legacy['SECURITY_WORKPLACE_TEST_MODE'], 'LEGACY_INTEGRATION')
        self.assertEqual(legacy['SECURITY_WORKPLACE_TEST_DATABASE'], standard['SECURITY_WORKPLACE_TEST_DATABASE'] + '_test')
        self.assertEqual(legacy['SECURITY_WORKPLACE_TEST_MARKER'], standard['SECURITY_WORKPLACE_TEST_MARKER'] + ':legacy-integration')
        self.assertLessEqual(len(legacy['SECURITY_WORKPLACE_TEST_DATABASE'].encode('ascii')), 63)
        for value in ('true', 'false', 1, 0, None):
            with self.subTest(mode=value), self.assertRaisesRegex(RuntimeError, 'EXPLICIT_FIXTURE_MODE'):
                fixture.fixture_identity(source, attempt, value)

    def test_creation_and_positive_shared_guard_bind_both_modes_and_reject_suffix_only(self):
        for legacy in (False, True):
            binding = fixture.fixture_identity('b' * 64, 'abcdef01', legacy)
            environment = {'NODE_ENV': 'test', **binding,
                           'DATABASE_URL': 'postgresql://synthetic:synthetic@postgres:5432/' + binding['SECURITY_WORKPLACE_TEST_DATABASE'] + '?sslmode=require&sslaccept=strict&sslcert=/run/trust/ca.crt'}
            for change, allowed in (({}, True), ({'SECURITY_WORKPLACE_TEST_MODE': ''}, False),
                                    ({'SECURITY_WORKPLACE_TEST_MODE': 'P1'}, False),
                                    ({'SECURITY_WORKPLACE_TEST_SOURCE_SHA': 'c' * 64}, False),
                                    ({'SECURITY_WORKPLACE_TEST_ATTEMPT': '00000000'}, False),
                                    ({'SECURITY_WORKPLACE_TEST_MARKER': 'test'}, False),
                                    ({'DATABASE_URL': 'postgresql://synthetic:synthetic@postgres:5432/anything_test'}, False),
                                    ({'NODE_TLS_REJECT_UNAUTHORIZED': '0'}, False)):
                code = ('process.env=' + json.dumps({**environment, **change}) + ';try{' + fixture.FIXTURE_BINDING_GUARD +
                        "console.log('PASS')}catch{console.log('REFUSED');process.exitCode=1}")
                result = subprocess.run(['node', '-e', code], text=True, capture_output=True, check=False)
                with self.subTest(legacy=legacy, change=change):
                    self.assertEqual(result.returncode, 0 if allowed else 1)
                    self.assertEqual(result.stdout.strip(), 'PASS' if allowed else 'REFUSED')
                    self.assertEqual(result.stderr, '')
            # A valid other-mode name/marker is not accepted without that mode.
            other = fixture.fixture_identity('b' * 64, 'abcdef01', not legacy)
            environment.update({'DATABASE_URL': 'postgresql://synthetic:synthetic@postgres:5432/' + other['SECURITY_WORKPLACE_TEST_DATABASE'] + '?sslmode=require&sslaccept=strict&sslcert=/run/trust/ca.crt'})
            code = 'process.env=' + json.dumps(environment) + ';try{' + fixture.FIXTURE_BINDING_GUARD + '}catch{process.exitCode=1}'
            self.assertEqual(subprocess.run(['node', '-e', code], capture_output=True, check=False).returncode, 1)

    def test_generated_fresh_and_positive_probes_are_valid_and_assert_actual_tls(self):
        for probe in (fixture.fresh_database_probe(), fixture.positive_probe()):
            self.assertIn(fixture.FIXTURE_BINDING_GUARD, probe)
            result = subprocess.run(['node', '--check'], input=probe, text=True, capture_output=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('pg_stat_ssl', fixture.positive_probe())
        self.assertIn('r.connector.stream.encrypted!==true', fixture.positive_probe())
        self.assertIn('r.connector.stream.authorized!==true', fixture.positive_probe())
        self.assertIn('b[0].marker!==null', fixture.fresh_database_probe())
        self.assertIn('t[0].count!==0', fixture.fresh_database_probe())

    def test_archive_hash_verified_and_unknown_permissions_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'source.tar.gz'
            payload = archive()
            path.write_bytes(payload)
            path.chmod(0o600)
            digest = hashlib.sha256(payload).hexdigest()
            self.assertEqual(fixture.verified_archive(path, digest), payload)
            with self.assertRaisesRegex(RuntimeError, 'HASH_MISMATCH'):
                fixture.verified_archive(path, 'f' * 64)
            path.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, 'UNSAFE_SOURCE_ARCHIVE'):
                fixture.verified_archive(path, digest)

    def test_bad_archive_hash_precedes_docker_and_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'source.tar.gz'
            path.write_bytes(archive())
            path.chmod(0o600)
            args = SimpleNamespace(local_development_only=True, npm_ci_completed=True,
                                   source_archive=str(path), source_sha='f' * 64, node_modules='/not-mounted/node_modules')
            candidate = fixture.Fixture(args)
            candidate.docker = Mock(side_effect=AssertionError('Docker must not be called'))
            original_fstat = fixture.os.fstat
            def fixture_owner(fd):
                fields = list(original_fstat(fd))
                fields[4] = 1000  # Match the synthetic non-root fixture identity.
                return fixture.os.stat_result(fields)
            with patch.object(fixture.os, 'geteuid', return_value=1000), patch.object(fixture.os, 'fstat', side_effect=fixture_owner), patch.object(fixture.socket, 'gethostname', return_value='local-test'), self.assertRaisesRegex(RuntimeError, 'HASH_MISMATCH'):
                candidate.create()
            candidate.docker.assert_not_called()
            self.assertIsNone(candidate.folder)


class ArchiveTests(unittest.TestCase):
    def test_required_schema_package_and32_migrations(self):
        records, lock = fixture.validated_source(archive())
        self.assertEqual(len([name for name, *_ in records if name.endswith('/migration.sql')]), 32)
        self.assertEqual(lock['lockfileVersion'], 3)
        for missing in ('packages/security-orchestration/package.json', 'packages/database/prisma/migrations/20261018000000_security_repair_journal/migration.sql'):
            files = required_files()
            del files[missing]
            with self.subTest(missing=missing), self.assertRaisesRegex(RuntimeError, 'REQUIRED_P1_SOURCE'):
                fixture.validated_source(archive(files))

    def test_links_devices_sparse_traversal_controls_and_duplicates(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE, tarfile.GNUTYPE_SPARSE):
            with self.subTest(kind=kind), self.assertRaises((RuntimeError, tarfile.TarError)):
                fixture.validated_source(archive(extra=[('unexpected', kind, b'')]))
        for name in ('../escape', '/absolute', 'a/../b', 'a//b', 'a\\b', 'a\nb', 'a\x7fb', 'package.json'):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                fixture.validated_source(archive(extra=[(name, tarfile.REGTYPE, b'x')]))

    def test_no_auth_secrets_runtime_or_managed_target_scope(self):
        paths = ('.ssh/config', 'auth-state/fixture.json', 'state/storageState.json', 'known_hosts', '.npmrc',
                 '.env', 'app.env', 'private.pem', 'data.dump', 'customer.sqlite',
                 'infrastructure/security-managed-target/helper.py', 'infrastructure/security-runtime/profile.json',
                 'scripts/security-runtime/provision.py')
        for name in paths:
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                fixture.validated_source(archive(extra=[(name, tarfile.REGTYPE, b'x')]))
        for body in (b'-----BEGIN PRIVATE KEY-----\n' + b'A' * 60, b'ghp_' + b'A' * 35):
            with self.subTest(body=body[:8]), self.assertRaisesRegex(RuntimeError, 'CREDENTIAL_MATERIAL'):
                fixture.validated_source(archive(extra=[('fixture.txt', tarfile.REGTYPE, body)]))
        records, _ = fixture.validated_source(archive(extra=[('.env.example', tarfile.REGTYPE, b'PUBLIC_EXAMPLE=yes')]))
        self.assertFalse(any(name.startswith('.env') for name, *_ in records))
        for name in fixture.CLIENT_ADAPTER_FILES:
            records, _ = fixture.validated_source(archive(extra=[(name, tarfile.REGTYPE, b'// reviewed client source')]))
            self.assertTrue(any(record[0] == name for record in records))

    def test_real_bounds_and_bounded_logic(self):
        self.assertEqual(fixture.MAX_FILE, 16777216)
        self.assertEqual(fixture.MAX_EXPANDED, 134217728)
        with patch.object(fixture, 'MAX_FILE', 2), self.assertRaisesRegex(RuntimeError, 'FILE_LIMIT'):
            fixture.validated_source(archive())
        with patch.object(fixture, 'MAX_EXPANDED', 2), self.assertRaisesRegex(RuntimeError, 'EXPANDED_LIMIT'):
            fixture.validated_source(archive())


class OverlayTests(unittest.TestCase):
    def test_completed_lock_and_nested_workspace_dependencies_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            modules = root / 'node_modules'
            (modules / '@prisma/client').mkdir(parents=True)
            (modules / '@prisma/client/package.json').write_text('{}')
            expected = {'lockfileVersion': 3, 'packages': {
                'node_modules/example': {'version': '1.0.0'},
                'apps/api/node_modules/zod': {'version': '3.0.0'}}}
            (modules / '.package-lock.json').write_text(json.dumps(expected))
            with self.assertRaisesRegex(RuntimeError, 'MISSING_NESTED'):
                fixture.dependency_mounts(modules, expected)
            nested = root / 'apps/api/node_modules'
            nested.mkdir(parents=True)
            self.assertEqual(fixture.dependency_mounts(modules, expected),
                             [(modules, '/workspace/node_modules'), (nested, '/workspace/apps/api/node_modules')])
            mismatched = json.loads(json.dumps(expected))
            mismatched['packages']['node_modules/example']['version'] = '2.0.0'
            with self.assertRaisesRegex(RuntimeError, 'LOCK_DOES_NOT_MATCH'):
                fixture.dependency_mounts(modules, mismatched)
            optional = json.loads(json.dumps(expected))
            optional['packages']['node_modules/platform-specific-optional'] = {'version': '1.0.0', 'optional': True}
            self.assertEqual(len(fixture.dependency_mounts(modules, optional)), 2)


class NegativeProbeTests(unittest.TestCase):
    def classify(self, cases):
        script = (fixture.NEGATIVE_CLASSIFIERS + '\nconsole.log(JSON.stringify(' + json.dumps(cases) +
                  '.map(c=>classifyNegative(c.service,c.kind,c.caught,c.firstError))));')
        result = subprocess.run(['node', '-e', script], text=True, capture_output=True, check=True)
        return json.loads(result.stdout)

    def test_only_expected_authentication_and_tls_codes_pass(self):
        cases = []
        def case(service, kind, caught=None, accepted=False, code=None, first=None):
            cases.append({'service': service, 'kind': kind, 'caught': caught, 'firstError': first,
                          'expected': {'accepted': accepted, 'code': code or 'NO_FAILURE'}})
        case('postgres', 'password', {'code': 'P1000'}, True, 'P1000')
        case('postgres', 'password', {'errorCode': 'P1000'}, True, 'P1000')
        initialization_auth = {'name': 'PrismaClientInitializationError', 'message': 'Invalid invocation:\n\nAuthentication failed against database server at `fixture-host`, the provided database credentials for `fixture-user` are not valid.\n\nCheck the credentials.'}
        case('postgres', 'password', initialization_auth, True, 'P1000')
        case('postgres', 'password', {**initialization_auth, 'message': 'Authentication failed against database server, the provided database credentials for `fixture-user` are not valid.'}, True, 'P1000')
        case('postgres', 'ca', initialization_auth, False, 'P1000')
        for change in ({'name': 'Error'}, {'name': 'PrismaClientUnknownRequestError'},
                       {'message': 'Cannot reach database server. Authentication failed earlier.'},
                       {'message': 'Authentication failed against database server at `fixture-host`, the provided database credentials for `fixture-user` are not valid.extra'},
                       {'code': 'P1001'}):
            case('postgres', 'password', {**initialization_auth, **change}, False, change.get('code', 'UNCLASSIFIED'))
        for kind in ('hostname', 'ca'):
            case('postgres', kind, {'code': 'P1011'}, True, 'P1011')
        for kind, cause, normalized in (
                ('hostname', 'certificate verify failed: (hostname mismatch)', 'PRISMA_INIT_TLS_HOSTNAME'),
                ('ca', 'certificate verify failed: (self-signed certificate in certificate chain)', 'PRISMA_INIT_TLS_CA')):
            error = {'name': 'PrismaClientInitializationError', 'message': 'Invalid invocation:\n\nError opening a TLS connection: ' + cause + '\n'}
            case('postgres', kind, error, True, normalized)
            case('postgres', 'ca' if kind == 'hostname' else 'hostname', error, False, normalized)
            case('postgres', 'password', error, False, normalized)
            case('postgres', kind, {**error, 'name': 'Error'}, False, 'UNCLASSIFIED')
        for message in ('Error opening a TLS connection: connection refused',
                        'Error opening a TLS connection: certificate verify failed',
                        'certificate verify failed: (hostname mismatch)',
                        'Earlier Error opening a TLS connection: certificate verify failed (hostname mismatch)'):
            for kind in ('hostname', 'ca'):
                case('postgres', kind, {'name': 'PrismaClientInitializationError', 'message': message}, False, 'UNCLASSIFIED')
        for code in ('P1001', 'P2010', 'P2024', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'):
            for kind in ('password', 'hostname', 'ca'):
                case('postgres', kind, {'code': code}, False, code)
        case('postgres', 'password', {'code': 'P1011'}, False, 'P1011')
        case('postgres', 'ca', {'code': 'P1000'}, False, 'P1000')
        case('redis', 'password', {'message': 'WRONGPASS invalid username-password pair'}, True, 'WRONGPASS')
        case('redis', 'password', {'code': 'WRONGPASS'}, True, 'WRONGPASS')
        case('redis', 'hostname', {'code': 'ERR_TLS_CERT_ALTNAME_INVALID'}, True, 'ERR_TLS_CERT_ALTNAME_INVALID')
        for code in ('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
                     'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_UNTRUSTED'):
            case('redis', 'ca', {'code': code}, True, code)
            case('redis', 'password', {'code': code}, False, code)
        for kind in ('password', 'hostname', 'ca'):
            for code in ('ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'NOAUTH', 'ERR_SSL_UNKNOWN_PROTOCOL'):
                case('redis', kind, {'code': code}, False, code)
            case('redis', kind, {'message': 'Connection is closed.'}, False, 'UNCLASSIFIED')
            case('redis', kind)
        case('redis', 'password', {'message': 'Connection is closed.'}, True, 'WRONGPASS',
             {'message': 'WRONGPASS invalid username-password pair'})
        case('redis', 'password', {'message': 'WRONGPASS invalid username-password pair'}, False, 'ECONNRESET',
             {'code': 'ECONNRESET'})
        case('redis', 'hostname', {'code': 'SELF_SIGNED_CERT_IN_CHAIN'}, False, 'SELF_SIGNED_CERT_IN_CHAIN')
        case('redis', 'ca', {'code': 'ERR_TLS_CERT_ALTNAME_INVALID'}, False, 'ERR_TLS_CERT_ALTNAME_INVALID')
        case('redis', 'password', {'message': 'WRONGPASSextra'}, False, 'UNCLASSIFIED')
        case('postgres', 'password', {'code': 'postgresql://private:secret@host'}, False, 'UNCLASSIFIED')
        actual = self.classify(cases)
        self.assertEqual(actual, [item['expected'] for item in cases])
        self.assertNotIn('private:secret', json.dumps(actual))

    def test_generated_probes_fail_on_outage_and_preserve_first_redis_error(self):
        # Driver stubs only: execute the exact generated probes without opening
        # sockets or importing installed Prisma/ioredis implementations.
        for service, code, expected in (('postgres', 'P1001', 1), ('postgres', 'P1000', 0),
                                        ('redis', 'ECONNREFUSED', 1), ('redis', 'WRONGPASS', 0)):
            stub = r'''const Module=require('node:module');const original=Module._load;
const error={code:CODE,message:CODE==='WRONGPASS'?'WRONGPASS invalid username-password pair':'private connection detail'};
Module._load=function(name,...args){
 if(name==='@prisma/client')return {PrismaClient:class{async $queryRawUnsafe(){throw error}async $disconnect(){}}};
 if(name==='ioredis')return class{constructor(_url,options){if(options.lazyConnect!==true)throw Error('missing lazy connect')}on(_event,listener){this.listener=listener}async connect(){this.listener(error);throw Error('Connection is closed.')}disconnect(){}};
 return original.call(this,name,...args);
};process.env.DATABASE_URL='postgresql://fixture:private@postgres/fixture';process.env.REDIS_URL='rediss://default:private@redis/0';'''.replace('CODE', json.dumps(code))
            result = subprocess.run(['node', '-e', stub + fixture.negative_probe(service, 'password')],
                                    text=True, capture_output=True, check=False)
            with self.subTest(service=service, code=code):
                self.assertEqual(result.returncode, expected, result.stderr)
                self.assertEqual(json.loads(result.stdout), {'service': service, 'check': 'password',
                                 'result': 'PASS' if expected == 0 else 'FAIL', 'code': code})
                self.assertNotIn('private', result.stdout + result.stderr)
        for service in ('postgres', 'redis'):
            for kind in ('password', 'hostname', 'ca'):
                result = subprocess.run(['node', '--check'], input=fixture.negative_probe(service, kind),
                                        text=True, capture_output=True, check=False)
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
